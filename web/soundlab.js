// The Sound panel: a music speed changer for enthusiasts. Tempo without the
// pitch moving (or both together, like a record), pitch in semitones, the
// song's BPM and key (worked out from the file, following the tempo and the
// pitch as they change), an A-B loop, markers, the waveform, and an effects
// chain - preamp, balance, an 8-band equalizer, compressor, limiter, vocal
// reducer, flanger, echo, reverb, mono, invert stereo - each with presets.
//
// Everything is kept in ONE file: <music folder>/configs/leonote-sound.json -
// the chain, the presets, each song's tempo, pitch, loop and markers, and what
// the analysis found (so a library sorts by BPM or loudness without reading
// every song again).
//
// Works on your own files. YouTube plays in its own player: there only the
// tempo, the loop and markers reach it.

import { h, debounce } from "./util.js";
import { icon } from "./icons.js";
import { menu, toast, askDialog } from "./ui.js";
import { DEFAULT_CHAIN, EQ_LABELS, EQ_PRESETS, SOUND_PRESETS, fullChain, presetChain } from "./audiograph.js";
import { keyName, transpose, KEYS, MOODS, packPeaks, unpackPeaks } from "./soundanalysis.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtT = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); const r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, "0")}`; };

/* ── the engine: one per app, alive whether or not the panel is open ───── */

let engine = null;
export function soundEngine(app, M) {
  if (engine) return engine;
  const S = app.settings;
  let cfg = { format: "leonote-sound", version: 1, chain: fullChain(), options: {}, presets: {}, tracks: {}, analysis: {} };
  let loaded = false;
  const listeners = new Set();
  const emit = () => { for (const f of listeners) try { f(); } catch {} };

  const dir = () => {
    const d = String(app.mediaDir ? app.mediaDir("audioFolder") : "").trim().replace(/^\/+|\/+$/g, "");
    return !d || d === "." || d === "./" ? "Utilities/Media/Music" : d;
  };
  const file = () => `${dir()}/configs/leonote-sound.json`;

  async function load() {
    try {
      const text = await app.host.readText(file());
      const m = JSON.parse(text);
      if (m && typeof m === "object") cfg = { ...cfg, ...m, chain: fullChain(m.chain), options: m.options || {}, presets: m.presets || {}, tracks: m.tracks || {}, analysis: m.analysis || {} };
    } catch { /* no file yet: the defaults */ }
    loaded = true;
    track(true);
    emit();
  }
  const save = debounce(async () => {
    try {
      const entry = await app.host.writeFile(file(), new TextEncoder().encode(JSON.stringify(cfg, null, 1)));
      if (entry && entry.path && app.vault.setFiles) app.vault.setFiles([...[...app.vault.files.values()].filter((f) => f.path !== entry.path), entry]);
    } catch (e) { console.warn("sound config", e); }
  }, 900);

  const key = () => M.current();
  const yt = () => M.isYouTube();
  const trackCfg = (k = key(), make = false) => { if (!k) return null; if (!cfg.tracks[k] && make) cfg.tracks[k] = {}; return cfg.tracks[k] || null; };
  const needsGraph = () => { const c = cfg.chain; return Object.values(c).some((x) => x && x.on) || Math.abs(pitch()) > 0.004; };
  const tempo = () => (trackCfg() || {}).tempo || M.rate || 1;
  const pitch = () => (cfg.options.joinPitch ? 12 * Math.log2(tempo()) : (trackCfg() || {}).pitch || 0);

  /** Put the chain and this song's pitch where they belong (the graph only when something needs it). */
  // told whenever the chain may have changed - light, unlike `on`, which repaints the panel
  const chainWatch = new Set();
  async function push() {
    for (const f of chainWatch) try { f(); } catch {}
    if (yt()) return;
    if (!needsGraph() && !(M.audio() && M.audio().ready)) return;
    const g = await M.graph();
    if (!g) return;
    g.setChain(cfg.chain);
    g.setPitch(cfg.options.joinPitch ? 0 : pitch());
  }
  const pushSoon = debounce(push, 40);

  // a new song: its own tempo, pitch and loop come back with it
  let lastKey = null;
  let lastHadTempo = false;
  function track(force) {
    const k = key();
    if (!force && k === lastKey) return;
    lastKey = k;
    M.setKeepPitch(!cfg.options.joinPitch);
    // a song's own tempo comes with it; after one, the next without goes back to as recorded
    const own = (trackCfg(k) || {}).tempo;
    if (own) M.setRate(own); else if (lastHadTempo) M.setRate(1);
    lastHadTempo = !!own;
    push();
    emit();
    // Auto: a song not read yet is read once, a moment after it starts (so the start plays clean)
    if (cfg.options.autoRead !== false && analyzable(k) && !cfg.analysis[k]) setTimeout(() => { if (key() === k && !cfg.analysis[k]) analyze(k); }, 1500);
  }
  M.bus.addEventListener("change", () => track(false));

  // the A-B loop, checked often enough to turn round on the beat - only while a loop is set and the song
  // plays: started and stopped by the Player's changes (play, pause, another song) and the loop's own
  let loopTimer = 0;
  const loopWatch = () => {
    const t = trackCfg();
    const need = !!(t && t.loop && M.playing());
    if (need && !loopTimer) loopTimer = setInterval(() => {
      const c = trackCfg();
      if (!c || !c.loop) return loopWatch();
      const [a, b] = c.loop;
      if (b > a && M.time() >= b) M.seek(a);
    }, 25);
    else if (!need && loopTimer) { clearInterval(loopTimer); loopTimer = 0; }
  };
  M.bus.addEventListener("change", loopWatch);
  listeners.add(loopWatch);

  /* analysis: once per file, remembered in the config */
  const queue = [];
  let busy = false;
  const analyzable = (k) => k && !/^yt:|^url:/i.test(k);
  function analysisOf(k) { const a = cfg.analysis[k]; if (!a) return null; if (a.peaks && typeof a.peaks === "string") a._peaks = a._peaks || unpackPeaks(a.peaks); return a; }
  function analyze(k, { force = false } = {}) {
    if (!analyzable(k)) return Promise.resolve(null);
    if (!force && cfg.analysis[k]) return Promise.resolve(analysisOf(k));
    return new Promise((resolve) => { queue.push({ k, resolve }); pump(); });
  }
  async function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const { k, resolve } = queue.shift();
    try {
      const { analyzeFile } = await import("./soundanalysis.js");
      const r = await analyzeFile(M.srcOf(k));
      cfg.analysis[k] = { bpm: r.bpm, key: r.key, loudness: r.loudness, density: r.density, mood: r.mood, duration: Math.round(r.duration), peaks: packPeaks(r.peaks), at: Date.now() };
      save();
      resolve(analysisOf(k));
    } catch (e) { console.warn("analysis", k, e); resolve(null); }
    busy = false;
    emit();
    setTimeout(pump, 30);
  }

  const api = {
    get cfg() { return cfg; },
    get loaded() { return loaded; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onChain(fn) { chainWatch.add(fn); return () => chainWatch.delete(fn); },
    save, emit, push: pushSoon, key, yt, tempo, pitch, trackCfg, analysisOf, analyze, analyzable,
    queued: () => queue.length + (busy ? 1 : 0),
    /** Tempo as a factor (1 = as recorded). */
    setTempo(r) {
      r = clamp(Math.round(r * 100) / 100, 0.25, 3);
      const t = trackCfg(key(), true);
      if (!t) return;
      t.tempo = r === 1 ? undefined : r;
      M.setRate(r);
      if (cfg.options.joinPitch) pushSoon();
      save();
    },
    setPitch(s) {
      if (cfg.options.joinPitch) return api.setTempo(Math.pow(2, s / 12));
      const t = trackCfg(key(), true);
      if (!t) return;
      t.pitch = Math.abs(s) < 0.004 ? undefined : Math.round(s * 100) / 100;
      pushSoon(); save();
    },
    file,
    setOption(k, v) { cfg.options = { ...cfg.options, [k]: v }; if (k === "joinPitch") { M.setKeepPitch(!v); pushSoon(); } save(); emit(); },
    setStage(name, patch) { cfg.chain = fullChain({ ...cfg.chain, [name]: { ...cfg.chain[name], ...patch } }); pushSoon(); save(); },
    resetStage(name) { cfg.chain = fullChain({ ...cfg.chain, [name]: { ...DEFAULT_CHAIN[name], on: cfg.chain[name].on } }); pushSoon(); save(); emit(); },
    setTrack(patch) { const t = trackCfg(key(), true); if (!t) return; Object.assign(t, patch); for (const k of Object.keys(t)) if (t[k] === undefined || t[k] === null) delete t[k]; save(); emit(); },
    /** The song's BPM as found (or as you corrected it), and as it plays now. */
    bpm() { const t = trackCfg() || {}; const a = analysisOf(key()) || {}; const b = t.bpm || a.bpm || 0; return { found: b, now: b * tempo() }; },
    songKey() { const t = trackCfg() || {}; const a = analysisOf(key()) || {}; const k = t.key || a.key || null; return { found: k, now: k ? transpose(k, pitch()) : null }; },
  };
  engine = api;
  load();
  return api;
}

/* ── the panel ──────────────────────────────────────────────────────────── */

const VIEWS = [
  ["tempo", "Tempo", ["tempo", "pitch", "loop", "markers", "wave"]],
  ["keybpm", "BPM", ["tempo", "bpm", "pitch", "key", "loop", "wave"]],
  ["markers", "Loop", ["loop", "markers", "wave"]],
  ["eq", "Equalizer", ["preamp", "balance", "equalizer"]],
  ["effects", "Effects", ["compressor", "limiter", "vocal", "flanger", "echo", "reverb", "mono", "invert"]],
  ["library", "Library: BPM, key, loudness, moods", ["song", "library"]],
  ["custom", "Custom", null],
];
const VIEW_ICON = { tempo: "music", keybpm: "hash", markers: "repeat", eq: "sliders", effects: "sparkles", library: "archive", custom: "layers" };
const COMPONENTS = [
  ["tempo", "Tempo"], ["bpm", "Beats per minute (BPM)"], ["pitch", "Pitch"], ["key", "Musical key"], ["loop", "Loop"], ["markers", "Markers"], ["wave", "Waveform"],
  ["preamp", "Preamp"], ["balance", "Balance"], ["equalizer", "Equalizer"], ["compressor", "Compressor"], ["limiter", "Limiter"], ["vocal", "Vocal reducer"],
  ["flanger", "Flanger"], ["echo", "Echo"], ["reverb", "Reverb"], ["mono", "Mono"], ["invert", "Invert stereo"], ["song", "This song's reading"], ["library", "Library tools"],
];

// the effects' sliders: [key, label, min, max, step, format]
const PCT = (v) => `${Math.round(v * 100)}%`;
const DB = (v) => `${v > 0 ? "+" : ""}${Math.round(v * 10) / 10} dB`;
const SEC = (v) => `${Math.round(v * 1000) / 1000} s`;
const PARAMS = {
  vocal: ["Vocal reducer", [["low", "Low freq cut", 20, 1000, 5, (v) => `${v} Hz`], ["high", "High freq cut", 1000, 16000, 50, (v) => `${v.toLocaleString()} Hz`]]],
  compressor: ["Compressor", [["wet", "Wet", 0, 1, 0.01, PCT], ["input", "Input gain", -24, 24, 0.5, DB], ["output", "Output gain", -24, 24, 0.5, DB], ["attack", "Attack", 0, 1, 0.001, SEC], ["release", "Release", 0, 1, 0.01, SEC], ["ratio", "Ratio", 1, 20, 0.5, (v) => String(v)], ["threshold", "Threshold", -60, 0, 0.5, DB]]],
  limiter: ["Limiter", [["ceiling", "Ceiling", -12, 0, 0.1, DB], ["threshold", "Threshold", -30, 0, 0.5, DB], ["release", "Release", 0.01, 1, 0.01, SEC]]],
  flanger: ["Flanger", [["wet", "Wet", 0, 1, 0.01, PCT], ["depth", "Depth", 0, 1, 0.01, PCT], ["beats", "Cycle length", 0.25, 32, 0.25, (v) => `${v} beats`], ["bpm", "Time", 40, 220, 1, (v) => `${v} BPM`], ["feedback", "Feedback", 0, 0.9, 0.01, PCT]]],
  echo: ["Echo", [["dry", "Dry", 0, 1, 0.01, PCT], ["wet", "Wet", 0, 1, 0.01, PCT], ["bpm", "Time", 40, 220, 1, (v) => `${v} BPM`], ["beats", "Delay", 0.0625, 4, 0.0625, (v) => `${v} beats`], ["decay", "Decay", 0, 0.95, 0.01, PCT]]],
  reverb: ["Reverb", [["wet", "Wet", 0, 1, 0.01, PCT], ["width", "Stereo width", 0, 1, 0.01, PCT], ["damping", "High freq damping", 0, 1, 0.01, PCT], ["size", "Room size", 0, 1, 0.01, PCT], ["predelay", "Pre-delay", 0, 250, 1, (v) => `${v} ms`], ["lowcut", "Low freq cut", 20, 1000, 5, (v) => `${v} Hz`]]],
  mono: ["Mono", [["left", "Left input gain", 0, 1, 0.01, PCT], ["right", "Right input gain", 0, 1, 0.01, PCT]]],
  invert: ["Invert stereo", []],
};

export function mountSoundLab(app, M, box) {
  const E = soundEngine(app, M);
  const S = app.settings;
  // the blocks shown: any number, stacked in the menu's order, each folding
  let views = Array.isArray(S.soundViews) ? S.soundViews.filter((id) => VIEWS.some((v) => v[0] === id)) : [S.soundView || "tempo"];
  const folded = new Set(S.soundFolded || []);
  const open = new Set(S.soundOpen || ["echo", "reverb"]);
  let raf = 0;
  let waveCanvas = null;

  const opt = (k, d) => (E.cfg.options[k] ?? d);
  const setViews = (next) => { views = VIEWS.map((v) => v[0]).filter((id) => next.includes(id)); app.setSetting("soundViews", views); paint(); };
  const viewMenu = (anchor) => menu(0, 0, [
    { header: "Show" },
    ...VIEWS.map(([id, name]) => ({ label: name, checked: views.includes(id), keep: true, run: () => setViews(views.includes(id) ? views.filter((x) => x !== id) : [...views, id]) })),
    { label: "Configure custom…", icon: "settings", run: () => configure(box.querySelector(".sl-view-pick") || anchor) },
    "sep",
    { label: "Join tempo and pitch (like a record)", checked: !!opt("joinPitch", false), run: () => E.setOption("joinPitch", !opt("joinPitch", false)) },
    { label: "Plus / minus buttons", checked: opt("plusMinus", true), run: () => E.setOption("plusMinus", !opt("plusMinus", true)) },
    { label: "Snap pitch to semitones", checked: !!opt("snapPitch", false), run: () => E.setOption("snapPitch", !opt("snapPitch", false)) },
  ], { anchor });
  function configure(anchor) {
    const cur = new Set(opt("custom", ["tempo", "pitch", "loop"]));
    menu(0, 0, [{ header: "Custom shows" }, ...COMPONENTS.map(([id, name]) => ({ label: name, checked: cur.has(id), keep: true, run: () => { cur.has(id) ? cur.delete(id) : cur.add(id); E.setOption("custom", COMPONENTS.map(([x]) => x).filter((x) => cur.has(x))); if (!views.includes("custom")) setViews([...views, "custom"]); else paint(); } }))], { anchor });
  }

  /* pieces */
  const row = (...kids) => h("div", { class: "sl-row" }, ...kids);
  const reset = (title, run, on = true) => h("button", { class: "icon-btn sl-reset", title, disabled: !on, onclick: run }, icon("rotateRight"));
  function slider(value, min, max, step, onInput, { onDone } = {}) {
    const i = h("input", { type: "range", class: "sl-range", min, max, step, value: String(value) });
    const fillTo = () => i.style.setProperty("--p", `${((Number(i.value) - min) / (max - min || 1)) * 100}%`);
    fillTo();
    i.addEventListener("input", () => { fillTo(); onInput(Number(i.value)); });
    // double-click: back to where it was when the panel was drawn
    i.addEventListener("dblclick", () => { i.value = String(value); fillTo(); onInput(Number(value)); });
    i.addEventListener("change", () => { if (onDone) onDone(Number(i.value)); });
    return i;
  }
  const pm = (delta, run) => (opt("plusMinus", true) ? h("button", { class: "icon-btn sl-pm", title: delta < 0 ? "Less" : "More", onclick: () => run(delta) }, icon(delta < 0 ? "minus" : "plus")) : null);

  function tempoC() {
    const t = E.tempo();
    const val = h("span", { class: "sl-val", text: `${Math.round(t * 100)}%` });
    const set = (r) => { E.setTempo(r); val.textContent = `${Math.round(E.tempo() * 100)}%`; };
    return h("section", { class: "sl-sec" },
      row(h("span", { class: "sl-lab", text: "Tempo" }), val, h("span", { class: "sl-gap" }), reset("Back to 100%", () => { set(1); paint(); })),
      row(pm(-0.01, (d) => { set(E.tempo() + d); paint(); }), slider(Math.round(t * 100), 25, 300, 1, (v) => set(v / 100)), pm(0.01, (d) => { set(E.tempo() + d); paint(); })));
  }
  function pitchC() {
    const p = E.pitch();
    const fmt = (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
    const val = h("span", { class: "sl-val", text: fmt(p) });
    const snap = opt("snapPitch", false);
    const set = (v) => { E.setPitch(v); val.textContent = fmt(E.pitch()); };
    return h("section", { class: "sl-sec" + (E.yt() ? " is-off" : "") },
      row(h("span", { class: "sl-lab", text: "Pitch" }), val, h("span", { class: "sl-dim", text: "semitones" }), h("span", { class: "sl-gap" }), reset("Back to the original pitch", () => { set(0); paint(); })),
      row(pm(-1, (d) => { set(Math.round(E.pitch()) + d); paint(); }), slider(p, -12, 12, snap ? 1 : 0.01, (v) => set(v)), pm(1, (d) => { set(Math.round(E.pitch()) + d); paint(); })),
      E.yt() ? h("p", { class: "sl-note", text: "YouTube plays in its own player: its pitch cannot be changed from here." }) : null);
  }
  function needReading(label) {
    const k = E.key();
    if (!E.analyzable(k)) return h("span", { class: "sl-dim", text: E.yt() ? "not for YouTube" : "—" });
    return h("button", { class: "link-btn", onclick: async (e) => { e.currentTarget.textContent = "Listening…"; await E.analyze(k); paint(); } }, label);
  }
  // Auto: each song read by itself (BPM, key, waveform), once, when it starts playing
  const autoBtn = () => {
    const on = opt("autoRead", true);
    return h("button", { class: "sl-auto" + (on ? " is-on" : ""), title: on ? "Each song is read by itself when it starts - BPM, key and waveform, once. Click to turn off" : "Read each song by itself when it starts (BPM, key and waveform, once)",
      onclick: () => { E.setOption("autoRead", !on); if (!on && E.analyzable(E.key())) E.analyze(E.key()).then(() => paint()); } }, "Auto");
  };
  function bpmC() {
    const b = E.bpm();
    const edit = (anchor) => menu(0, 0, [
      { header: "Beats per minute" },
      { label: "Type it…", icon: "edit", run: async () => { const r = await askDialog("BPM of this song", [{ key: "v", label: "Beats per minute", value: String(Math.round(b.found || 120)) }], { ok: "Set" }); const v = r && Number(r.v); if (v > 20 && v < 400) { E.setTrack({ bpm: v }); paint(); } } },
      b.found ? { label: `Double it (${Math.round(b.found * 2)})`, icon: "plus", run: () => { E.setTrack({ bpm: b.found * 2 }); paint(); } } : null,
      b.found ? { label: `Halve it (${Math.round(b.found / 2)})`, icon: "minus", run: () => { E.setTrack({ bpm: b.found / 2 }); paint(); } } : null,
      { label: "Tap it out…", icon: "clock", run: () => tap() },
      { label: "Work it out again", icon: "rotateRight", run: async () => { E.setTrack({ bpm: undefined }); await E.analyze(E.key(), { force: true }); paint(); } },
    ], { anchor });
    return h("section", { class: "sl-sec" }, row(h("span", { class: "sl-lab", text: "BPM" }), autoBtn(),
      b.found ? h("button", { class: "sl-link", title: "Correct it", onclick: (e) => edit(e.currentTarget) }, String(Math.round(b.found * 10) / 10)) : needReading("Work it out"),
      b.found ? h("span", { class: "sl-arrow", text: "→" }) : null,
      b.found ? h("b", { class: "sl-now", text: String(Math.round(b.now)) }) : null));
  }
  function tap() {
    const taps = [];
    const out = h("b", { class: "sl-tap-n", text: "—" });
    const pad = h("button", { class: "sl-tap", onclick: () => { const now = performance.now(); if (taps.length && now - taps[taps.length - 1] > 2500) taps.length = 0; taps.push(now); if (taps.length > 1) { const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); out.textContent = String(Math.round(60000 / iv / E.tempo())); } } }, "Tap on the beat");
    const pop = h("div", { class: "menu sl-tap-pop is-in" }, pad, out,
      h("button", { class: "btn btn-sm btn-primary", onclick: () => { const v = Number(out.textContent); if (v > 20) { E.setTrack({ bpm: v }); paint(); } pop.remove(); } }, "Use it"));
    document.getElementById("overlay-root").append(pop);
    const r = box.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left + 20)}px`; pop.style.top = `${Math.max(8, r.top + 40)}px`;
    const away = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", away, true); } };
    setTimeout(() => document.addEventListener("mousedown", away, true));
  }
  function keyC() {
    const k = E.songKey();
    const pick = (anchor) => menu(0, 0, [
      { header: "The song's key" },
      ...KEYS.map((n, t) => ({ label: `${n} major  ·  ${n}m minor`, sub: [{ label: `${n} major`, run: () => { E.setTrack({ key: { tonic: t, minor: false } }); paint(); } }, { label: `${n} minor`, run: () => { E.setTrack({ key: { tonic: t, minor: true } }); paint(); } }] })),
      "sep",
      { label: "Work it out again", icon: "rotateRight", run: async () => { E.setTrack({ key: undefined }); await E.analyze(E.key(), { force: true }); paint(); } },
    ], { anchor });
    return h("section", { class: "sl-sec" }, row(h("span", { class: "sl-lab", text: "Key" }),
      k.found ? h("button", { class: "sl-link", title: "Correct it", onclick: (e) => pick(e.currentTarget) }, keyName(k.found)) : needReading("Work it out"),
      k.found ? h("span", { class: "sl-arrow", text: "→" }) : null,
      k.found ? h("b", { class: "sl-now", text: keyName(k.now) }) : null));
  }
  function loopC() {
    const t = E.trackCfg() || {};
    const [a, b] = t.loop || [null, null];
    const setA = () => { const now = M.time(); E.setTrack({ loop: [now, b != null && b > now ? b : now + 8] }); paint(); };
    const setB = () => { const now = M.time(); E.setTrack({ loop: [a != null && a < now ? a : Math.max(0, now - 8), now] }); paint(); };
    return h("section", { class: "sl-sec" }, row(h("span", { class: "sl-lab", text: "Loop" }),
      h("button", { class: "sl-ab" + (a != null ? " is-on" : ""), title: "The loop starts here (now)", onclick: setA }, "A", a != null ? h("small", { text: fmtT(a) }) : null),
      h("button", { class: "sl-ab" + (b != null ? " is-on" : ""), title: "The loop turns back here (now)", onclick: setB }, "B", b != null ? h("small", { text: fmtT(b) }) : null),
      h("span", { class: "sl-gap" }),
      t.loop ? h("button", { class: "icon-btn", title: "No loop", onclick: () => { E.setTrack({ loop: undefined }); paint(); } }, icon("x")) : null));
  }
  function markersC() {
    const t = E.trackCfg() || {};
    const list = (t.markers || []).slice().sort((x, y) => x - y);
    return h("section", { class: "sl-sec" },
      row(h("span", { class: "sl-lab", text: "Markers" }), h("button", { class: "sl-ab", title: "A marker here (now)", onclick: () => { E.setTrack({ markers: [...list, Math.round(M.time() * 10) / 10] }); paint(); } }, icon("plus")),
        h("span", { class: "sl-chips" }, ...list.map((m) => h("button", { class: "sl-chip", title: "Go there · right-click to remove", onclick: () => M.seek(m), oncontextmenu: (e) => { e.preventDefault(); E.setTrack({ markers: list.filter((x) => x !== m) }); paint(); } }, fmtT(m))))));
  }
  function waveC() {
    const a = E.analysisOf(E.key());
    waveCanvas = h("canvas", { class: "sl-wave" });
    const holder = h("section", { class: "sl-sec sl-wave-sec" }, waveCanvas, h("span", { class: "sl-wave-auto" }, autoBtn()));
    if (!a && E.analyzable(E.key())) holder.append(h("div", { class: "sl-wave-empty" }, needReading("Draw the waveform (and find the BPM and key)")));
    // click or drag: go there
    const go = (e) => { const r = waveCanvas.getBoundingClientRect(); const d = M.duration(); if (d > 0) { M.seek(clamp((e.clientX - r.left) / r.width, 0, 1) * d); requestAnimationFrame(drawWave); } };
    waveCanvas.addEventListener("pointerdown", (e) => { go(e); const mv = (m) => go(m); const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); }; addEventListener("pointermove", mv); addEventListener("pointerup", up); });
    return holder;
  }
  function drawWave() {
    if (!waveCanvas || !waveCanvas.isConnected) return;
    const a = E.analysisOf(E.key());
    const w = waveCanvas.clientWidth, hh = waveCanvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (waveCanvas.width !== Math.round(w * dpr)) { waveCanvas.width = Math.round(w * dpr); waveCanvas.height = Math.round(hh * dpr); }
    const g = waveCanvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const peaks = a && a._peaks;
    const d = M.duration() || (a && a.duration) || 0;
    const at = d ? M.time() / d : 0;
    const css = getComputedStyle(box);
    const accent = css.getPropertyValue("--accent").trim() || "#e0a84a";
    const dim = css.getPropertyValue("--text-4").trim() || "#666";
    const t = E.trackCfg() || {};
    if (t.loop && d) { g.fillStyle = "rgba(128,128,128,.18)"; g.fillRect((t.loop[0] / d) * w, 0, ((t.loop[1] - t.loop[0]) / d) * w, hh); }
    if (peaks) {
      const n = peaks.length, bw = w / n;
      for (let i = 0; i < n; i++) {
        const v = Math.max(0.04, peaks[i] / 255);
        g.fillStyle = i / n < at ? accent : dim;
        g.fillRect(i * bw + bw * 0.2, (hh - v * hh * 0.9) / 2, Math.max(1, bw * 0.6), v * hh * 0.9);
      }
    }
    for (const m of t.markers || []) if (d) { g.fillStyle = accent; g.fillRect((m / d) * w - 1, 0, 2, hh); }
    g.fillStyle = "#fff"; g.fillRect(at * w - 1, 0, 2, hh);
  }

  function stageHead(name, label, { collapsible = true } = {}) {
    const st = E.cfg.chain[name];
    const sw = h("button", { class: "switch" + (st.on ? " is-on" : ""), role: "switch", title: st.on ? "On" : "Off", onclick: () => { E.setStage(name, { on: !st.on }); paint(); } });
    const chevron = collapsible ? h("button", { class: "icon-btn sl-chev" + (open.has(name) ? " is-open" : ""), title: open.has(name) ? `Fold ${label}` : `Unfold ${label}`, onclick: () => { open.has(name) ? open.delete(name) : open.add(name); app.setSetting("soundOpen", [...open]); paint(); } }, icon("chevronDown")) : null;
    const fold = () => { open.has(name) ? open.delete(name) : open.add(name); app.setSetting("soundOpen", [...open]); paint(); };
    return row(h("span", { class: "sl-lab sl-stage" + (collapsible ? " is-fold" : ""), text: label, onclick: collapsible ? fold : null }), chevron, h("span", { class: "sl-gap" }), sw, reset(`${label}: back to its defaults`, () => { E.resetStage(name); paint(); }));
  }
  /* Presets: one button. A preset is the whole sound - every effect as it is set now; the
     equalizer's built-in curves and presets saved per effect before load from the same menu. */
  async function savePreset() {
    const r = await askDialog("Save the sound as a preset", [{ key: "v", label: "Name", value: "" }], { ok: "Save" });
    const name = r && String(r.v || "").trim();
    if (!name) return;
    E.cfg.presets = { ...E.cfg.presets, chain: { ...(E.cfg.presets.chain || {}), [name]: JSON.parse(JSON.stringify(E.cfg.chain)) } };
    E.save();
    E.setOption("preset", "mine:" + name);
    const where = E.file();
    toast(`Saved “${name}” in ${where}`, { ms: 8000, actions: [
      { label: "Open", run: () => setTimeout(() => app.openFile(where, { newTab: true }), 1000) },
      { label: "Show", run: () => setTimeout(() => app.revealInTree(where), 1000) },
    ] });
  }
  const STAGE_NAMES = { eq: "Equalizer", preamp: "Preamp", balance: "Balance", ...Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v[0]])) };
  // every preset there is: Default first, yours next, then the built-in ones by group, then
  // the equalizer's curves and what was saved per effect before (those change one stage only)
  function presetList() {
    const P = E.cfg.presets || {};
    const out = [{ id: "default", group: "", name: "Default", hint: "everything off", chain: () => fullChain(Object.fromEntries(Object.entries(DEFAULT_CHAIN).map(([k, d]) => [k, { ...d, on: false }]))) }];
    for (const [n, v] of Object.entries(P.chain || {})) out.push({ id: "mine:" + n, group: "Yours", name: n, mine: "chain", chain: () => fullChain(v) });
    for (const [g, n, st] of SOUND_PRESETS) out.push({ id: "lib:" + n, group: g, name: n, chain: () => presetChain(st) });
    for (const [k, g] of Object.entries(EQ_PRESETS)) out.push({ id: "eq:" + k, group: "Equalizer curves", name: k[0].toUpperCase() + k.slice(1), stage: ["eq", { on: true, gains: g.slice() }] });
    for (const [k, list] of Object.entries(P)) if (k !== "chain" && list) for (const [n, v] of Object.entries(list)) out.push({ id: `old:${k}:${n}`, group: "Yours, one effect", name: `${STAGE_NAMES[k] || k}: ${n}`, mine: k, key: n, stage: [k, { ...v, on: true }] });
    return out;
  }
  const sameChain = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // the preset the sound is set to now, if it still is
  function presetNow() {
    const id = opt("preset", "");
    const p = id && presetList().find((x) => x.id === id);
    return p && p.chain && sameChain(p.chain(), E.cfg.chain) ? p : null;
  }
  function applyPreset(p) {
    if (p.chain) { E.cfg.chain = p.chain(); E.push(); E.save(); } else E.setStage(p.stage[0], p.stage[1]);
    E.setOption("preset", p.chain ? p.id : "");
  }
  const anyOn = () => Object.values(E.cfg.chain).some((x) => x && x.on);
  function allEffects(on) {
    const chain = E.cfg.chain;
    let names;
    if (!on) { names = Object.keys(chain).filter((k) => chain[k] && chain[k].on); E.setOption("lastOn", names); }
    else names = (opt("lastOn", []) || []).filter((k) => chain[k]);
    if (on && !names.length) return toast("Nothing to turn back on - switch an effect on, or pick a preset", { ms: 3000 });
    E.cfg.chain = fullChain(Object.fromEntries(Object.entries(chain).map(([k, v]) => [k, { ...v, on: on ? names.includes(k) : false }])));
    E.push();
    E.save();
    paint();
  }
  let presetPop = null;
  function presetsMenu(anchor) {
    if (presetPop) { presetPop.close(); return; }
    const q = h("input", { class: "input sl-pp-find", placeholder: "Find a preset", spellcheck: false });
    const list = h("div", { class: "sl-pp-list" });
    const pop = h("div", { class: "sl-pp" }, q, list,
      h("div", { class: "sl-pp-foot" },
        h("button", { class: "btn btn-sm", onclick: () => { close(); savePreset(); } }, icon("save"), "Save the sound…"),
        h("span", { class: "sl-gap" }),
        h("button", { class: "icon-btn", title: "Where your presets are kept", onclick: () => { close(); app.revealInTree(E.file()); } }, icon("folder"))));
    const drop = (p) => { const all = { ...(E.cfg.presets[p.mine] || {}) }; delete all[p.mine === "chain" ? p.name : p.key]; E.cfg.presets = { ...E.cfg.presets, [p.mine]: all }; E.save(); draw(); };
    let rows = [];
    let at = -1;
    function draw() {
      const words = q.value.trim().toLowerCase();
      const now = presetNow();
      const all = presetList().filter((p) => !words || `${p.name} ${p.group}`.toLowerCase().includes(words));
      rows = [];
      const kids = [];
      let last = null;
      for (const p of all) {
        if (p.group !== last) { last = p.group; if (p.group) kids.push(h("div", { class: "sl-pp-group", text: p.group })); }
        const b = h("button", { class: "sl-pp-row" + (now && now.id === p.id ? " is-on" : ""), title: p.mine ? "The Delete key removes this preset" : null, onclick: () => { applyPreset(p); draw(); }, onkeydown: p.mine ? (e) => { if (e.key === "Delete") { e.preventDefault(); e.stopPropagation(); drop(p); q.focus(); } } : null },
          h("span", { text: p.name }), p.hint ? h("small", { text: p.hint }) : null,
          p.mine ? h("span", { class: "sl-pp-x", title: "Delete this preset", onclick: (e) => { e.stopPropagation(); drop(p); } }, icon("x")) : null);
        rows.push(b);
        kids.push(b);
      }
      list.replaceChildren(...(kids.length ? kids : [h("div", { class: "sl-pp-none", text: "No preset of that name." })]));
    }
    // arrows walk the list and play each preset as they go
    q.addEventListener("input", () => { at = -1; draw(); });
    q.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      e.preventDefault();
      if (e.key === "Enter") { if (rows[Math.max(0, at)]) rows[Math.max(0, at)].click(); return; }
      at = Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
      rows[at].click();
      rows = [...list.querySelectorAll(".sl-pp-row")];
      rows[at].classList.add("is-cursor");
      rows[at].scrollIntoView({ block: "nearest" });
    });
    document.getElementById("overlay-root").append(pop);
    const r = anchor.getBoundingClientRect();
    const w = 260;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
    const below = innerHeight - r.bottom - 12;
    if (below >= 260) { pop.style.top = `${r.bottom + 6}px`; pop.style.maxHeight = `${below}px`; } else { pop.style.bottom = `${innerHeight - r.top + 6}px`; pop.style.maxHeight = `${r.top - 12}px`; }
    const away = (e) => { if (!pop.contains(e.target) && !(e.target.closest && e.target.closest(".sl-presets"))) close(); };
    function close() { pop.remove(); document.removeEventListener("mousedown", away, true); presetPop = null; }
    setTimeout(() => document.addEventListener("mousedown", away, true));
    presetPop = { close };
    draw();
    q.focus();
  }
  function simpleStage(name, label, key, min, max, step, fmt) {
    const st = E.cfg.chain[name];
    const val = h("span", { class: "sl-val", text: fmt(st[key]) });
    return h("section", { class: "sl-sec" + (st.on ? "" : " is-off") },
      row(h("span", { class: "sl-lab sl-stage", text: label }), val, h("span", { class: "sl-gap" }),
        h("button", { class: "switch" + (st.on ? " is-on" : ""), role: "switch", onclick: () => { E.setStage(name, { on: !st.on }); paint(); } }),
        reset(`${label}: back to its defaults`, () => { E.resetStage(name); paint(); })),
      row(slider(st[key], min, max, step, (v) => { E.setStage(name, { [key]: v }); val.textContent = fmt(v); })));
  }
  function eqC() {
    const st = E.cfg.chain.eq;
    const bands = h("div", { class: "sl-eq" }, ...st.gains.map((v, i) => {
      const val = h("span", { class: "sl-eq-val", text: `${v > 0 ? "+" : ""}${v.toFixed(1)}` });
      const inp = h("input", { type: "range", class: "sl-eq-range", min: -12, max: 12, step: 0.5, value: String(v), "aria-label": EQ_LABELS[i] });
      // the bar fills from the middle (0 dB) to the value
      const fillTo = () => inp.style.setProperty("--p", `${((Number(inp.value) + 12) / 24) * 100}%`);
      fillTo();
      inp.addEventListener("input", () => { fillTo(); const g = E.cfg.chain.eq.gains.slice(); g[i] = Number(inp.value); E.setStage("eq", { gains: g, on: true }); val.textContent = `${g[i] > 0 ? "+" : ""}${g[i].toFixed(1)}`; });
      return h("label", { class: "sl-eq-band" }, val, inp, h("span", { class: "sl-eq-hz", text: EQ_LABELS[i] }));
    }));
    return h("section", { class: "sl-sec" + (st.on ? "" : " is-off") }, stageHead("eq", "Equalizer"), open.has("eq") ? bands : null);
  }
  function fxC(name) {
    const [label, params] = PARAMS[name];
    const st = E.cfg.chain[name];
    const sec = h("section", { class: "sl-sec" + (st.on ? "" : " is-off") }, stageHead(name, label, { collapsible: params.length > 0 }));
    if (!params.length || !open.has(name)) return sec;
    for (const [k, lab, min, max, step, fmt] of params) {
      const val = h("span", { class: "sl-val", text: fmt(st[k]) });
      const sync = k === "bpm" && E.bpm().now ? h("button", { class: "icon-btn", title: "The song's own tempo", onclick: () => { E.setStage(name, { bpm: Math.round(E.bpm().now) }); paint(); } }, icon("repeat")) : null;
      sec.append(h("div", { class: "sl-param" }, h("span", { class: "sl-lab", text: lab }), slider(st[k], min, max, step, (v) => { E.setStage(name, { [k]: v }); val.textContent = fmt(v); }), val, sync));
    }
    return sec;
  }
  function songC() {
    const k = E.key();
    const a = E.analysisOf(k);
    if (!a) return h("section", { class: "sl-sec" }, row(h("span", { class: "sl-lab", text: "This song" }), h("span", { class: "sl-gap" }), needReading("Read it: BPM, key, loudness")));
    const mood = MOODS.find((m) => m[0] === a.mood);
    return h("section", { class: "sl-sec" }, row(h("span", { class: "sl-lab", text: "This song" })),
      h("div", { class: "sl-facts" },
        h("div", {}, h("b", { text: String(Math.round(E.bpm().found)) }), h("span", { text: "BPM" })),
        h("div", {}, h("b", { text: keyName(E.songKey().found) }), h("span", { text: "key" })),
        h("div", {}, h("b", { text: `${a.loudness} dB` }), h("span", { text: "loudness" })),
        h("div", {}, h("b", { text: mood ? mood[1] : "—" }), h("span", { text: "mood" }))));
  }
  function libraryC() {
    const q = E.queued();
    return h("section", { class: "sl-sec" },
      row(h("span", { class: "sl-lab", text: "Your music" })),
      h("p", { class: "sl-note", text: "Sort the list by BPM, loudness or energy (the Sort button), or make playlists by mood. A song is read once and remembered in configs/leonote-sound.json in your music folder." }),
      q ? h("p", { class: "sl-note", text: `Reading ${q} song${q === 1 ? "" : "s"}…` }) : null,
      row(h("button", { class: "btn btn-sm", onclick: () => app.bus.emit("sound:analyze-list") }, icon("sparkles"), "Read every song in the list"),
        h("button", { class: "btn btn-sm", onclick: (e) => app.bus.emit("sound:moods", e.currentTarget) }, icon("list"), "Playlists by mood…")));
  }

  const PIECES = {
    tempo: tempoC, pitch: pitchC, bpm: bpmC, key: keyC, loop: loopC, markers: markersC, wave: waveC,
    preamp: () => simpleStage("preamp", "Preamp", "db", -12, 12, 0.5, (v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}`),
    balance: () => simpleStage("balance", "Balance", "pan", -1, 1, 0.01, (v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(2)}`),
    equalizer: eqC, song: songC, library: libraryC,
    compressor: () => fxC("compressor"), limiter: () => fxC("limiter"), vocal: () => fxC("vocal"), flanger: () => fxC("flanger"), echo: () => fxC("echo"), reverb: () => fxC("reverb"), mono: () => fxC("mono"), invert: () => fxC("invert"),
  };

  let body = null;
  function paint() {
    if (box.hidden) return;
    const keep = body ? body.scrollTop : 0;
    const shown = VIEWS.filter((v) => views.includes(v[0]));
    const seen = new Set();
    const groups = shown.map(([id, name, list]) => {
      // a piece in two blocks shows in the first only
      const parts = (id === "custom" ? opt("custom", ["tempo", "pitch", "loop"]) : list).filter((p) => !seen.has(p) && PIECES[p]);
      for (const p of parts) seen.add(p);
      const shut = folded.has(id);
      const head = shown.length > 1 ? h("div", { class: "sl-group-head" + (shut ? " is-shut" : ""), title: shut ? "Unfold" : "Fold", onclick: () => { shut ? folded.delete(id) : folded.add(id); app.setSetting("soundFolded", [...folded]); paint(); } },
        // as Settings' groups: the block's icon, its name, then hide and the fold arrow at the end
        h("span", { class: "sl-group-ico" }, icon(VIEW_ICON[id] || "sliders")), h("span", { class: "sl-group-name", text: name }), h("span", { class: "sl-gap" }),
        h("button", { class: "icon-btn", title: "Hide this block", onclick: (e) => { e.stopPropagation(); setViews(views.filter((x) => x !== id)); } }, icon("x")),
        icon("chevronDown", "sl-group-caret")) : null;
      // YouTube plays in its own player: its sound never passes through here
      const SOUND = ["preamp", "balance", "equalizer", "compressor", "limiter", "vocal", "flanger", "echo", "reverb", "mono", "invert"];
      const ytNote = E.yt() && parts.some((p) => SOUND.includes(p)) ? h("p", { class: "sl-note sl-yt-note", text: "YouTube plays in its own player, so its sound never reaches the equalizer or the effects - they work on your own files and direct audio or video links. Tempo and the loop do reach YouTube." }) : null;
      return h("div", { class: "sl-group" }, head, ...(shut && head ? [] : [ytNote, ...parts.map((p) => { const el = PIECES[p](); if (ytNote && SOUND.includes(p)) el.classList.add("is-yt-off"); return el; })].filter(Boolean)));
    });
    // the names fold the panel to this one line (and open it again); the arrow picks the blocks
    const shut = S.soundPanelFolded === true;
    const title = h("span", { class: "sl-view" },
      h("button", { class: "sl-view-name", title: shut ? "Unfold the panel" : "Fold the panel to this line", onclick: () => { app.setSetting("soundPanelFolded", !shut); paint(); } },
        shown.length === 1 ? shown[0][1] : shown.length ? "Sound" : "Nothing shown"),
      h("button", { class: "sl-view-pick", title: "Choose the blocks shown - several can stack", onclick: (e) => viewMenu(e.currentTarget) }, icon("chevronDown")));
    body = h("div", { class: "sl-body", hidden: shut }, ...(groups.length ? groups : [h("p", { class: "sl-note sl-empty", text: "Pick what to show from the menu above." })]));
    wheelThrough(body);
    const master = h("button", { class: "switch sl-master" + (anyOn() ? " is-on" : ""), role: "switch", title: anyOn() ? "Every effect off (the switch turns them back on as they were)" : "Turn back on the effects that were on", onclick: () => allEffects(!anyOn()) });
    box.replaceChildren(h("div", { class: "sl-head" }, h("button", { class: "sl-fold" + (shut ? " is-shut" : ""), title: shut ? "Unfold the panel" : "Fold the panel to this line", onclick: () => { app.setSetting("soundPanelFolded", !shut); paint(); } }, icon("sliders")), title, h("span", { class: "sl-gap" }), master,
      h("button", { class: "link-btn sl-presets", title: "Presets: try one, or save the sound as one", onclick: (e) => presetsMenu(e.currentTarget) }, (presetNow() || {}).name || "Presets", icon("chevronDown")),
      h("button", { class: "icon-btn", title: "Blocks and options", onclick: (e) => viewMenu(e.currentTarget) }, icon("more"))),
      body);
    body.scrollTop = keep;
    loop();
  }
  /* The wheel: the panel scrolls; once it is at its end, the page around it goes on - but only
     on a new turn of the wheel, after a pause, so scrolling the settings never runs on past them. */
  let wheelAt = 0; // the last wheel turn that the panel itself took (or stopped at its end)
  function wheelThrough(el) {
    el.addEventListener("wheel", (e) => {
      if (e.ctrlKey || !e.deltaY) return;
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
      const now = performance.now();
      const atEnd = px > 0 ? el.scrollTop + el.clientHeight >= el.scrollHeight - 1 : el.scrollTop <= 0;
      const sameTurn = now - wheelAt < 450;
      if (!atEnd || sameTurn) { wheelAt = now; return; }
      let outer = box.parentElement;
      while (outer && !(outer.scrollHeight > outer.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(outer).overflowY))) outer = outer.parentElement;
      if (!outer) return;
      e.preventDefault();
      outer.scrollBy({ top: px });
    }, { passive: false });
  }
  // the waveform moves only while something plays and the panel is in sight: otherwise one drawing, then no frames
  // (it ran every frame for the whole session once the Player had been opened)
  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (!box.isConnected || box.hidden || !box.offsetParent) { raf = 0; return; }
      drawWave();
      raf = M.playing() ? requestAnimationFrame(tick) : 0;
    };
    raf = requestAnimationFrame(tick);
  }
  const onState = () => loop();
  M.bus.addEventListener("state", onState);
  // a seek while paused (keys, the seek bar, the mini window): the playhead drawn where it went
  const onTime = () => { if (!raf) loop(); };
  M.bus.addEventListener("time", onTime);
  // back in sight (the Player opened again): drawn, and moving if it plays
  const seen = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loop(); });
  seen.observe(box);
  const off = E.on(() => { if (!box.hidden) paint(); });
  paint();
  return { paint, destroy: () => { off(); cancelAnimationFrame(raf); M.bus.removeEventListener("state", onState); M.bus.removeEventListener("time", onTime); seen.disconnect(); } };
}
