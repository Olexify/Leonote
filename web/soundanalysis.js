// What a song is, worked out from its samples: tempo (BPM), key, loudness,
// a waveform to draw, and how busy it is - enough to sort a library by feel
// and make "calm" or "chaotic" playlists. Pure maths on Float32Arrays, so it
// runs in tests; `analyzeFile` does the decoding in the page.

export const KEYS = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
export const MOODS = [
  ["calm", "Calm", "slow and quiet"],
  ["slow", "Slow", "under 90 BPM"],
  ["medium", "Medium", "90 to 120 BPM"],
  ["fast", "Fast", "120 to 150 BPM"],
  ["energetic", "Energetic", "fast and loud"],
  ["chaotic", "Chaotic", "loud, dense and restless"],
];

/** "Bm", "F♯", "E♭m" - a key as people write it. */
export const keyName = (k) => (k && Number.isInteger(k.tonic) ? KEYS[((k.tonic % 12) + 12) % 12] + (k.minor ? "m" : "") : "—");
/** The key `semis` semitones up (down when negative). */
export const transpose = (k, semis) => (k && Number.isInteger(k.tonic) ? { tonic: (((k.tonic + Math.round(semis)) % 12) + 12) % 12, minor: !!k.minor } : k);

/** One channel at about `target` Hz: the channels averaged, then every `n` samples averaged into one. */
export function monoDown(channels, rate, target = 11025) {
  const n = Math.max(1, Math.floor(rate / target));
  const len = Math.floor(channels[0].length / n);
  const out = new Float32Array(len);
  const c = channels.length;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) for (let k = 0; k < c; k++) s += channels[k][i * n + j];
    out[i] = s / (n * c);
  }
  return { samples: out, rate: rate / n };
}

/** `n` bars of loudness for a waveform, 0-255. */
export function peaksOf(x, n = 240) {
  const out = new Uint8Array(n);
  const step = x.length / n;
  let top = 1e-9;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.floor(i * step); j < Math.min(x.length, Math.floor((i + 1) * step)); j++) { s += x[j] * x[j]; c++; }
    raw[i] = Math.sqrt(s / Math.max(1, c));
    if (raw[i] > top) top = raw[i];
  }
  for (let i = 0; i < n; i++) out[i] = Math.round((raw[i] / top) * 255);
  return out;
}

/** Loudness in dB (RMS of the louder 70% of 400 ms windows - silences between tracks do not pull it down). */
export function loudnessOf(x, rate) {
  const w = Math.max(1, Math.round(rate * 0.4));
  const vals = [];
  for (let i = 0; i + w <= x.length; i += w) {
    let s = 0;
    for (let j = i; j < i + w; j++) s += x[j] * x[j];
    vals.push(s / w);
  }
  if (!vals.length) return -90;
  vals.sort((a, b) => b - a);
  const keep = vals.slice(0, Math.max(1, Math.ceil(vals.length * 0.7)));
  const ms = keep.reduce((a, b) => a + b, 0) / keep.length;
  return Math.max(-90, 10 * Math.log10(ms + 1e-12));
}

/** How the sound changes, frame by frame: the onset envelope that tempo is read from. */
function onsets(x, rate, hop = 128) {
  const n = Math.floor(x.length / hop);
  const env = new Float32Array(n);
  // energy over a window four hops wide (46 ms): long enough that a held note
  // or a drone reads steady, so only real attacks rise above the small gate
  const win = hop * 4;
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i * hop - win / 2), b = Math.min(x.length, i * hop + win / 2);
    const e = Math.log(1e-6 + (sq[b] - sq[a]) / Math.max(1, b - a));
    env[i] = i ? Math.max(0, e - prev - 0.05) : 0;
    prev = e;
  }
  // take out the slow drift, so only the hits are left
  const w = 16;
  const out = new Float32Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += env[i] - (i >= w ? env[i - w] : 0);
    out[i] = Math.max(0, env[i] - run / Math.min(i + 1, w));
  }
  return { env: out, fps: rate / hop };
}

/**
 * Tempo in beats per minute: the lag at which the onset envelope best repeats,
 * between 60 and 200 BPM, folded into 70-180 (where a song's pulse is felt).
 */
export function bpmOf(x, rate) {
  const { env, fps } = onsets(x, rate);
  if (env.length < fps * 4) return 0;
  const lagOf = (bpm) => (60 * fps) / bpm;
  const lo = Math.floor(lagOf(200)), hi = Math.ceil(lagOf(60));
  const ac = new Float32Array(hi + 2);
  for (let lag = lo; lag <= hi + 1; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (env.length - lag);
  }
  // a beat that also lines up at twice the lag is the stronger case
  let best = lo, score = -1;
  for (let lag = lo; lag <= hi; lag++) {
    const sc = ac[lag] + 0.5 * (2 * lag <= hi + 1 ? ac[2 * lag] || 0 : 0);
    if (sc > score) { score = sc; best = lag; }
  }
  // between the frames: the peak of a parabola through the three around it
  const a = ac[best - 1] || 0, b = ac[best], c = ac[best + 1] || 0;
  const d = a - 2 * b + c;
  const off = d < 0 ? (0.5 * (a - c)) / d : 0;
  const lag = best + (Math.abs(off) < 1 ? off : 0);
  let bpm = (60 * fps) / lag;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

/** How busy it is: onsets a second that stand well above the rest. */
export function densityOf(x, rate) {
  const { env, fps } = onsets(x, rate);
  if (!env.length) return 0;
  const sorted = Float32Array.from(env).sort();
  const gate = sorted[Math.floor(sorted.length * 0.9)] || 0;
  let n = 0;
  for (let i = 1; i < env.length - 1; i++) if (env[i] > gate && env[i] >= env[i - 1] && env[i] >= env[i + 1]) n++;
  return n / (env.length / fps);
}

// the major and minor key profiles (Krumhansl-Kessler)
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** The twelve pitch classes' share of the sound, C first. */
export function chromaOf(x, rate, size = 4096) {
  const chroma = new Float64Array(12);
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const re = new Float64Array(size), im = new Float64Array(size);
  // the bins' pitch classes, worked out once (55 Hz - 2 kHz: the notes, not the hiss)
  const pc = new Int8Array(size / 2).fill(-1);
  for (let k = 1; k < size / 2; k++) {
    const f = (k * rate) / size;
    if (f < 55 || f > 2000) continue;
    pc[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
  }
  const hop = size;
  for (let at = 0; at + size <= x.length; at += hop) {
    for (let i = 0; i < size; i++) { re[i] = x[at + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < size / 2; k++) if (pc[k] >= 0) chroma[pc[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  return chroma;
}

/** The key: the major or minor profile, turned to each of the twelve, that best matches the chroma. */
export function keyOf(x, rate) {
  const ch = chromaOf(x, rate);
  const corr = (a, b) => {
    const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db || 1);
  };
  let best = { tonic: 0, minor: false }, score = -2;
  for (let t = 0; t < 12; t++) {
    for (const [prof, minor] of [[MAJOR, false], [MINOR, true]]) {
      const rot = Array.from({ length: 12 }, (_, i) => prof[(i - t + 12) % 12]);
      const s = corr(ch, rot);
      if (s > score) { score = s; best = { tonic: t, minor }; }
    }
  }
  return best;
}

/** A mood from tempo, loudness and busyness - the one "Playlists by mood" files it under. */
export function moodOf({ bpm, loudness, density }) {
  const loud = loudness > -11, quiet = loudness < -18;
  if (loud && density > 3.2 && bpm >= 125) return "chaotic";
  if (bpm >= 120 && loud) return "energetic";
  if (bpm < 90 && quiet) return "calm";
  if (bpm < 90) return "slow";
  if (bpm < 120) return "medium";
  return "fast";
}

/** Everything at once, from decoded channels. */
export function analyzeChannels(channels, rate) {
  const { samples, rate: r } = monoDown(channels, rate);
  const bpm = bpmOf(samples, r);
  const loudness = Math.round(loudnessOf(samples, r) * 10) / 10;
  const density = Math.round(densityOf(samples, r) * 100) / 100;
  const key = keyOf(samples, r);
  return { bpm, key, loudness, density, mood: moodOf({ bpm, loudness, density }), peaks: peaksOf(samples, 240), duration: channels[0].length / rate };
}

/** A song file (a URL the page can fetch) decoded and read. */
export async function analyzeFile(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`read failed (${res.status})`);
  const buf = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(buf);
  const channels = [];
  for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(audio.getChannelData(c));
  // let the page breathe before the maths
  await new Promise((r) => setTimeout(r));
  return analyzeChannels(channels, audio.sampleRate);
}

/** Peaks to a short string for the config file, and back. */
export const packPeaks = (p) => btoa(String.fromCharCode(...p));
export const unpackPeaks = (s) => { try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; } };
