// The Player's sound chain, built only when first asked for. A media element
// joins it once (createMediaElementSource is one-shot) and stays in it; if
// Web Audio fails, playback simply goes on without it.
//
//   source → pitch → preamp → balance → equalizer (8 bands) → vocal reducer
//   → compressor → limiter → flanger → echo → reverb → mono → invert stereo
//   → analyser (the visualizer) → speakers
//
// Every stage is always in place; "off" is a setting that makes it pass the
// sound through untouched (a wet mix of 0, a gain of 1, a ratio of 1), so
// switching one never re-wires the graph under a playing song.

export const EQ_BANDS = [60, 150, 400, 1000, 2000, 4000, 8000, 16000];
export const EQ_LABELS = ["60", "150", "400", "1K", "2K", "4K", "8K", "16K"];
export const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 2, 0, 0, 0, 0, 0],
  vocal: [-2, -1, 1, 3, 4, 3, 1, 0],
  treble: [0, 0, 0, 0, 1, 3, 5, 6],
  loud: [5, 3, 0, -1, 0, 2, 4, 5],
  rock: [4, 3, 1, -1, 0, 2, 3, 4],
  bright: [0, 0, 1, 1, 0, 4, 3, 3],
};
// kept for the few places that still speak of the old five bands
export const BANDS = EQ_BANDS;
export const PRESETS = EQ_PRESETS;

export const DEFAULT_CHAIN = {
  preamp: { on: false, db: -3 },
  balance: { on: false, pan: 0 },
  eq: { on: false, gains: EQ_PRESETS.flat.slice() },
  vocal: { on: false, low: 120, high: 9000 },
  compressor: { on: false, wet: 1, input: 0, output: 0, attack: 0.003, release: 0.3, ratio: 3, threshold: -18 },
  limiter: { on: false, ceiling: -0.3, threshold: -3, release: 0.05 },
  flanger: { on: false, wet: 0.7, depth: 0.16, beats: 16, bpm: 128, feedback: 0.35 },
  echo: { on: false, dry: 0.35, wet: 0.6, bpm: 128, beats: 0.25, decay: 0.6 },
  reverb: { on: false, wet: 0.3, width: 1, damping: 0.5, size: 0.8, predelay: 0, lowcut: 20 },
  mono: { on: false, left: 0.5, right: 0.5 },
  invert: { on: false },
};

/*
 * Whole-sound presets, built in: [group, name, stages]. A stage named is turned on with
 * what is given over its defaults; every other stage is off. EQ bands: 60 150 400 1K 2K 4K 8K 16K.
 */
const comp = (ratio, threshold, more = {}) => ({ ratio, threshold, attack: 0.01, release: 0.25, ...more });
export const SOUND_PRESETS = [
  ["Tone", "Bass boost", { eq: { gains: [6, 5, 2, 0, 0, 0, 0, 0] }, limiter: {} }],
  ["Tone", "Deep bass", { preamp: { db: -4 }, eq: { gains: [9, 7, 3, 0, -1, 0, 0, 0] }, limiter: {} }],
  ["Tone", "Treble boost", { eq: { gains: [0, 0, 0, 0, 1, 3, 5, 6] }, limiter: {} }],
  ["Tone", "Warm", { eq: { gains: [3, 3, 2, 0, -1, -2, -2, -3] } }],
  ["Tone", "Bright", { eq: { gains: [0, 0, 1, 1, 0, 4, 3, 3] } }],
  ["Tone", "Vocal clarity", { eq: { gains: [-2, -1, 1, 3, 4, 3, 1, 0] }, compressor: comp(2.5, -20) }],
  ["Tone", "Loudness (quiet listening)", { preamp: { db: -3 }, eq: { gains: [5, 3, 0, -1, 0, 2, 4, 5] }, limiter: {} }],
  ["Genre", "Rock", { eq: { gains: [4, 3, 1, -1, 0, 2, 3, 4] } }],
  ["Genre", "Pop", { eq: { gains: [-1, 1, 3, 4, 3, 1, -1, -1] } }],
  ["Genre", "Jazz", { eq: { gains: [3, 2, 1, 2, -1, -1, 0, 2] } }],
  ["Genre", "Classical", { eq: { gains: [3, 2, 0, 0, 0, 0, 2, 3] }, reverb: { wet: 0.12, size: 0.7 } }],
  ["Genre", "Electronic", { eq: { gains: [5, 4, 1, 0, -1, 2, 3, 4] }, limiter: {} }],
  ["Genre", "Hip-hop", { eq: { gains: [6, 5, 1, 2, -1, 1, 1, 2] }, limiter: {} }],
  ["Genre", "Acoustic", { eq: { gains: [3, 2, 1, 1, 2, 2, 3, 2] } }],
  ["Genre", "Metal", { eq: { gains: [4, 2, -2, -1, 1, 3, 4, 3] }, compressor: comp(3, -16) }],
  ["Space", "Small room", { reverb: { wet: 0.18, size: 0.3, damping: 0.6 } }],
  ["Space", "Concert hall", { reverb: { wet: 0.35, size: 0.85, predelay: 20 } }],
  ["Space", "Cathedral", { reverb: { wet: 0.5, size: 1, damping: 0.3, predelay: 45 } }],
  ["Space", "Slapback echo", { echo: { dry: 1, wet: 0.35, beats: 0.125, decay: 0.15 } }],
  ["Space", "Dub delay", { echo: { dry: 0.8, wet: 0.55, beats: 0.75, decay: 0.7 }, reverb: { wet: 0.15 } }],
  ["Space", "Slowed + reverb", { eq: { gains: [3, 2, 1, 0, -1, -2, -3, -4] }, reverb: { wet: 0.45, size: 0.92, damping: 0.6, predelay: 15 } }],
  ["Character", "Lo-fi radio", { eq: { gains: [-12, -6, 2, 4, 3, -4, -10, -12] }, compressor: comp(4, -24) }],
  ["Character", "Telephone", { eq: { gains: [-12, -12, -2, 6, 6, -2, -12, -12] }, mono: {} }],
  ["Character", "Underwater", { eq: { gains: [4, 4, 0, -6, -10, -12, -12, -12] }, reverb: { wet: 0.4, size: 0.6, damping: 0.9 } }],
  ["Character", "Jet flanger", { flanger: { wet: 0.7, depth: 0.3, feedback: 0.5 } }],
  ["Character", "Karaoke (voice out)", { vocal: {} }],
  ["Character", "Old record", { eq: { gains: [-8, -2, 2, 3, 2, -2, -8, -12] }, mono: {}, reverb: { wet: 0.08, size: 0.2 } }],
  ["Listening", "Night mode", { eq: { gains: [-3, -1, 0, 0, 0, 0, -1, -2] }, compressor: comp(6, -30, { output: 4 }), limiter: { ceiling: -1 } }],
  ["Listening", "Podcast and speech", { eq: { gains: [-6, -3, 2, 4, 4, 2, 0, -2] }, compressor: comp(4, -24, { output: 3 }), limiter: {} }],
  ["Listening", "Small speakers", { preamp: { db: -2 }, eq: { gains: [-4, 2, 3, 2, 1, 1, 2, 1] }, limiter: {} }],
  ["Listening", "Headphones, relaxed", { eq: { gains: [2, 1, 0, 0, -1, -2, -1, 0] } }],
  ["Listening", "In the car", { eq: { gains: [4, 3, 0, -1, 0, 2, 3, 3] }, compressor: comp(2.5, -18) }],
  ["Listening", "Mastering polish", { eq: { gains: [1, 0, 0, 0, 0, 1, 1, 2] }, compressor: comp(2, -14), limiter: { ceiling: -0.5 } }],
  ["Listening", "Mono", { mono: {} }],
  ["Listening", "Left and right swapped", { invert: {} }],
];
/** The chain a built-in preset makes: what it names on, the rest off. */
export function presetChain(stages) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULT_CHAIN)) out[k] = stages[k] ? { ...d, ...stages[k], on: true } : { ...d, on: false };
  return fullChain(out);
}

/** A chain with every stage filled in - what a saved or half-written one becomes. */
export function fullChain(c = {}) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULT_CHAIN)) out[k] = { ...d, ...(c && c[k] && typeof c[k] === "object" ? c[k] : {}) };
  if (!Array.isArray(out.eq.gains) || out.eq.gains.length !== EQ_BANDS.length) out.eq.gains = EQ_PRESETS.flat.slice();
  return out;
}

const db = (v) => Math.pow(10, v / 20);

// The pitch shifter: two read heads sweeping through a short delay line, each
// faded in and out (sin²) so their sum stays level - a pitch change with the
// tempo left alone (the element's own time-stretch looks after the tempo).
const PITCH_WORKLET = `
class LeoPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: "ratio", defaultValue: 1, minValue: 0.25, maxValue: 4 }]; }
  constructor() { super(); this.L = 16384; this.N = 2048; this.buf = [new Float32Array(this.L), new Float32Array(this.L)]; this.w = 0; this.ph = 0; }
  read(b, pos) { const L = this.L; pos = ((pos % L) + L) % L; const i = Math.floor(pos); const f = pos - i; return b[i] * (1 - f) + b[(i + 1) % L] * f; }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    const r = params.ratio[0];
    const n = out[0].length, N = this.N, L = this.L;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) this.buf[c][this.w] = inp && inp.length ? (inp[Math.min(c, inp.length - 1)][i] || 0) : 0;
      this.ph += (1 - r) / N;
      this.ph -= Math.floor(this.ph);
      const p1 = this.ph, p2 = (this.ph + 0.5) % 1;
      const w1 = Math.sin(Math.PI * p1) ** 2, w2 = Math.sin(Math.PI * p2) ** 2;
      for (let c = 0; c < out.length; c++) {
        const b = this.buf[Math.min(c, 1)];
        out[c][i] = w1 * this.read(b, this.w - 1 - p1 * N) + w2 * this.read(b, this.w - 1 - p2 * N);
      }
      this.w = (this.w + 1) % L;
    }
    return true;
  }
}
registerProcessor("leo-pitch", LeoPitch);
`;

export function createAudioGraph() {
  let ctx = null;
  let failed = false;
  let analyser = null;
  let input = null;
  const sources = new WeakMap();
  let chain = fullChain();
  let semis = 0;
  let pitch = null; // the worklet node, once loaded
  let pitchDirect = true;
  let pitchOut = null;
  const n = {}; // the nodes, by stage
  let irKey = "";

  const gain = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const biquad = (type, f, q = 0.707) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const set = (param, v) => { if (param) param.setTargetAtTime(v, ctx.currentTime, 0.03); };

  /** in → [effect] → out, with a dry path beside it: `wet` and `dry` choose the mix. */
  function stage() {
    const s = { in: gain(), out: gain(), dry: gain(1), wet: gain(0) };
    s.in.connect(s.dry); s.dry.connect(s.out); s.wet.connect(s.out);
    return s;
  }

  function build() {
    input = gain();
    pitchOut = gain();
    input.connect(pitchOut);
    n.pre = gain();
    n.bal = ctx.createStereoPanner();
    n.eq = EQ_BANDS.map((f, i) => biquad(i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking", f, 1.1));
    pitchOut.connect(n.pre); n.pre.connect(n.bal); n.bal.connect(n.eq[0]);
    for (let i = 0; i < n.eq.length - 1; i++) n.eq[i].connect(n.eq[i + 1]);

    // vocal reducer: in the band where voices sit, what is the same in both channels is taken out
    const v = (n.vocal = stage());
    const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
    v.in.connect(sp);
    v.lowL = biquad("lowpass", 120); v.lowR = biquad("lowpass", 120);
    v.highL = biquad("highpass", 9000); v.highR = biquad("highpass", 9000);
    v.bandL = [biquad("highpass", 120), biquad("lowpass", 9000)]; v.bandR = [biquad("highpass", 120), biquad("lowpass", 9000)];
    const negL = gain(-1), negR = gain(-1), sideL = gain(), sideR = gain();
    sp.connect(v.lowL, 0); sp.connect(v.highL, 0); sp.connect(v.lowR, 1); sp.connect(v.highR, 1);
    sp.connect(sideL, 0); sp.connect(negR, 1); negR.connect(sideL);
    sp.connect(sideR, 1); sp.connect(negL, 0); negL.connect(sideR);
    sideL.connect(v.bandL[0]); v.bandL[0].connect(v.bandL[1]);
    sideR.connect(v.bandR[0]); v.bandR[0].connect(v.bandR[1]);
    for (const [node, ch] of [[v.lowL, 0], [v.highL, 0], [v.bandL[1], 0], [v.lowR, 1], [v.highR, 1], [v.bandR[1], 1]]) node.connect(mg, 0, ch);
    mg.connect(v.wet);
    n.eq[n.eq.length - 1].connect(v.in);

    // compressor, with gain before and after, and a wet mix (parallel compression)
    const c = (n.comp = stage());
    c.inGain = gain(); c.node = ctx.createDynamicsCompressor(); c.outGain = gain();
    c.in.connect(c.inGain); c.inGain.connect(c.node); c.node.connect(c.outGain); c.outGain.connect(c.wet);
    v.out.connect(c.in);

    // limiter: a hard, fast compressor and the ceiling
    const l = (n.lim = stage());
    l.node = ctx.createDynamicsCompressor(); l.node.ratio.value = 20; l.node.knee.value = 0; l.node.attack.value = 0.001; l.ceil = gain();
    l.in.connect(l.node); l.node.connect(l.ceil); l.ceil.connect(l.wet);
    c.out.connect(l.in);

    // flanger: a short delay swept by a slow wave, fed back into itself
    const fl = (n.fl = stage());
    fl.delay = ctx.createDelay(0.05); fl.delay.delayTime.value = 0.005; fl.fb = gain(0);
    fl.lfo = ctx.createOscillator(); fl.lfo.frequency.value = 0.1; fl.depth = gain(0);
    fl.lfo.connect(fl.depth); fl.depth.connect(fl.delay.delayTime); fl.lfo.start();
    fl.in.connect(fl.delay); fl.delay.connect(fl.wet); fl.delay.connect(fl.fb); fl.fb.connect(fl.delay);
    l.out.connect(fl.in);

    // echo, timed in beats of the song
    const ec = (n.echo = stage());
    ec.delay = ctx.createDelay(6); ec.fb = gain(0);
    ec.in.connect(ec.delay); ec.delay.connect(ec.wet); ec.delay.connect(ec.fb); ec.fb.connect(ec.delay);
    fl.out.connect(ec.in);

    // reverb: a room drawn as an impulse (noise that dies away), after a pre-delay, its lows cut
    const rv = (n.rev = stage());
    rv.pre = ctx.createDelay(1); rv.conv = ctx.createConvolver(); rv.cut = biquad("highpass", 20);
    rv.in.connect(rv.pre); rv.pre.connect(rv.conv); rv.conv.connect(rv.cut); rv.cut.connect(rv.wet);
    ec.out.connect(rv.in);

    // mono: both channels to one, each with its own share
    const mo = (n.mono = stage());
    const msp = ctx.createChannelSplitter(2), mmg = ctx.createChannelMerger(2);
    mo.left = gain(0.5); mo.right = gain(0.5); const sum = gain();
    mo.in.connect(msp); msp.connect(mo.left, 0); msp.connect(mo.right, 1); mo.left.connect(sum); mo.right.connect(sum);
    sum.connect(mmg, 0, 0); sum.connect(mmg, 0, 1); mmg.connect(mo.wet);
    rv.out.connect(mo.in);

    // invert stereo: left and right trade places
    const iv = (n.inv = stage());
    const isp = ctx.createChannelSplitter(2), img = ctx.createChannelMerger(2);
    iv.in.connect(isp); isp.connect(img, 0, 1); isp.connect(img, 1, 0); img.connect(iv.wet);
    mo.out.connect(iv.in);

    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    iv.out.connect(analyser);
    analyser.connect(ctx.destination);
  }

  function impulse(r) {
    const key = `${r.size}|${r.damping}|${r.width}`;
    if (key === irKey) return;
    irKey = key;
    const secs = 0.3 + r.size * 5.7;
    const len = Math.round(ctx.sampleRate * secs);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    const a = buf.getChannelData(0), b = buf.getChannelData(1);
    let la = 0, lb = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, 2.2 + r.size * 2);
      // damping: a low-pass that closes as the tail goes on
      const k = 1 - Math.min(0.97, r.damping * 0.9 * t + 0.02);
      const na = Math.random() * 2 - 1, nb = r.width >= 1 ? Math.random() * 2 - 1 : na * (1 - r.width) + (Math.random() * 2 - 1) * r.width;
      la += k * (na - la); lb += k * (nb - lb);
      a[i] = la * env; b[i] = lb * env;
    }
    n.rev.conv.buffer = buf;
  }

  function apply() {
    if (!ctx) return;
    const c = chain;
    set(n.pre.gain, c.preamp.on ? db(c.preamp.db) : 1);
    set(n.bal.pan, c.balance.on ? c.balance.pan : 0);
    n.eq.forEach((f, i) => set(f.gain, c.eq.on ? c.eq.gains[i] || 0 : 0));
    // vocal reducer
    const v = n.vocal;
    for (const f of [v.lowL, v.lowR, v.bandL[0], v.bandR[0]]) set(f.frequency, c.vocal.low);
    for (const f of [v.highL, v.highR, v.bandL[1], v.bandR[1]]) set(f.frequency, c.vocal.high);
    set(v.wet.gain, c.vocal.on ? 1 : 0); set(v.dry.gain, c.vocal.on ? 0 : 1);
    // compressor
    const cp = n.comp;
    set(cp.inGain.gain, db(c.compressor.input)); set(cp.outGain.gain, db(c.compressor.output));
    set(cp.node.threshold, c.compressor.threshold); set(cp.node.ratio, c.compressor.ratio);
    set(cp.node.attack, c.compressor.attack); set(cp.node.release, c.compressor.release);
    set(cp.wet.gain, c.compressor.on ? c.compressor.wet : 0); set(cp.dry.gain, c.compressor.on ? 1 - c.compressor.wet : 1);
    // limiter
    const lm = n.lim;
    set(lm.node.threshold, c.limiter.threshold); set(lm.node.release, c.limiter.release); set(lm.ceil.gain, db(c.limiter.ceiling));
    set(lm.wet.gain, c.limiter.on ? 1 : 0); set(lm.dry.gain, c.limiter.on ? 0 : 1);
    // flanger: one sweep every `beats` beats
    const fl = n.fl;
    set(fl.lfo.frequency, Math.max(0.01, c.flanger.bpm / 60 / Math.max(0.25, c.flanger.beats)));
    set(fl.depth.gain, c.flanger.depth * 0.004);
    set(fl.fb.gain, c.flanger.on ? c.flanger.feedback : 0);
    set(fl.wet.gain, c.flanger.on ? c.flanger.wet : 0); set(fl.dry.gain, 1);
    // echo: its delay is `beats` of the song's beat
    const ec = n.echo;
    set(ec.delay.delayTime, Math.min(5.9, (60 / Math.max(20, c.echo.bpm)) * c.echo.beats));
    set(ec.fb.gain, c.echo.on ? Math.min(0.95, c.echo.decay) : 0);
    set(ec.wet.gain, c.echo.on ? c.echo.wet : 0); set(ec.dry.gain, c.echo.on ? c.echo.dry : 1);
    // reverb
    const rv = n.rev;
    if (c.reverb.on) impulse(c.reverb);
    set(rv.pre.delayTime, c.reverb.predelay / 1000); set(rv.cut.frequency, c.reverb.lowcut);
    set(rv.wet.gain, c.reverb.on ? c.reverb.wet : 0); set(rv.dry.gain, 1);
    // mono, invert
    set(n.mono.left.gain, c.mono.left); set(n.mono.right.gain, c.mono.right);
    set(n.mono.wet.gain, c.mono.on ? 1 : 0); set(n.mono.dry.gain, c.mono.on ? 0 : 1);
    set(n.inv.wet.gain, c.invert.on ? 1 : 0); set(n.inv.dry.gain, c.invert.on ? 0 : 1);
  }

  async function loadPitch() {
    if (pitch || !ctx || !ctx.audioWorklet) return;
    const url = URL.createObjectURL(new Blob([PITCH_WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
      pitch = new AudioWorkletNode(ctx, "leo-pitch", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    } catch (e) { console.warn("pitch", e); }
    URL.revokeObjectURL(url);
  }
  /** The pitch route: straight through at 0, through the shifter otherwise. */
  async function routePitch() {
    if (!ctx) return;
    const want = Math.abs(semis) > 0.004;
    if (want) await loadPitch();
    if (want && pitch) {
      pitch.parameters.get("ratio").setValueAtTime(Math.pow(2, semis / 12), ctx.currentTime);
      if (pitchDirect) { input.connect(pitch); pitch.connect(pitchOut); input.disconnect(pitchOut); pitchDirect = false; }
    } else if (!pitchDirect) {
      input.connect(pitchOut);
      try { input.disconnect(pitch); pitch.disconnect(pitchOut); } catch {}
      pitchDirect = true;
    }
  }

  function init() {
    if (ctx || failed) return !!ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      build();
      apply();
      // a pitch asked for before there was a chain to put it in
      if (Math.abs(semis) > 0.004) routePitch();
      return true;
    } catch (e) {
      console.warn("audio graph", e);
      failed = true;
      ctx = null;
      return false;
    }
  }

  return {
    get ready() { return !!ctx; },
    get failed() { return failed; },
    /** Route a media element through the chain (once). */
    attach(el) {
      if (!el || !init()) return false;
      if (sources.has(el)) return true;
      try {
        const s = ctx.createMediaElementSource(el);
        s.connect(input);
        sources.set(el, s);
        return true;
      } catch (e) { console.warn("audio source", e); return false; }
    },
    has: (el) => sources.has(el),
    /** Out of the chain for good (a song let go): its node no longer keeps the element alive. */
    detach(el) { const s = sources.get(el); if (!s) return; try { s.disconnect(); } catch {} sources.delete(el); },
    resume() { if (ctx && ctx.state !== "running") ctx.resume().catch(() => {}); },
    /** Asleep while nothing plays: a running context wakes the CPU about 100 times a second, in the tray too. */
    suspend() { if (ctx && ctx.state === "running") ctx.suspend().catch(() => {}); },
    /** The whole chain's settings (see DEFAULT_CHAIN); missing stages keep their defaults. */
    setChain(c) { chain = fullChain(c); if (ctx) apply(); },
    chain: () => chain,
    /** Pitch in semitones, the tempo left alone. */
    setPitch(s) { semis = Number(s) || 0; routePitch(); },
    // the old five-band call: spread over the eight bands
    setGains(g) { const src = (g || []).slice(0, 5); const at = (x) => { const i = Math.min(3, Math.floor(x)); const f = x - i; return (src[i] || 0) * (1 - f) + (src[i + 1] || 0) * f; }; chain = fullChain({ ...chain, eq: { on: true, gains: EQ_BANDS.map((_, i) => Math.round(at((i / 7) * 4))) } }); if (ctx) apply(); },
    gains: () => chain.eq.gains.slice(),
    /** Fill `out` (Uint8Array(analyser.frequencyBinCount)); false without a graph. */
    levels(out) { if (!analyser) return false; analyser.getByteFrequencyData(out); return true; },
    bins: () => (analyser ? analyser.frequencyBinCount : 0),
  };
}
