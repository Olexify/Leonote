// Small interface sounds, made on the spot with Web Audio - little bells
// with soft overtones (the same voice as the Kitsumi site), so there are no
// files to ship or license. Quiet by default; one setting turns them off.

let ac = null;
let master = null;
let last = 0;
let idle = 0;

function audio(volume) {
  if (!ac) {
    try {
      ac = new AudioContext();
      master = ac.createGain();
      master.connect(ac.destination);
    } catch { return null; }
  }
  if (ac.state === "suspended") ac.resume().catch(() => {});
  master.gain.value = 0.5 * Math.min(1, volume) * 2;
  return ac;
}

function voice(t) {
  // one note: frequency, length, wave, loudness, delay, optional glide
  const tone = (f, dur, type = "sine", vol = 0.2, at = 0, slideTo = null) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t + at);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + at + dur);
    g.gain.setValueAtTime(0, t + at);
    g.gain.linearRampToValueAtTime(vol, t + at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
    o.connect(g).connect(master);
    o.start(t + at);
    o.stop(t + at + dur + 0.05);
  };
  // a breath of filtered noise, for paper and brush textures
  const noise = (dur, vol = 0.2, at = 0, hp = 800, lp = 20000) => {
    const n = ac.createBufferSource();
    const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    n.buffer = buf;
    const f1 = ac.createBiquadFilter();
    f1.type = "highpass";
    f1.frequency.value = hp;
    const f2 = ac.createBiquadFilter();
    f2.type = "lowpass";
    f2.frequency.value = lp;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t + at);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
    n.connect(f1).connect(f2).connect(g).connect(master);
    n.start(t + at);
  };
  const bell = (f, dur = 1.2, vol = 0.12, at = 0) => {
    tone(f, dur, "sine", vol, at);
    tone(f * 2, dur * 0.55, "sine", vol * 0.3, at);
    tone(f * 2.99, dur * 0.3, "sine", vol * 0.1, at);
    tone(f * 0.5, dur * 0.8, "triangle", vol * 0.15, at);
  };
  return { tone, noise, bell };
}

const SOUNDS = {
  // a task ticked off: two bells, a fifth apart
  done: ({ bell }) => { bell(659.25, 1.1, 0.11); bell(987.77, 1.4, 0.1, 0.13); },
  // unticked: a short step down
  undone: ({ tone }) => { tone(587.33, 0.16, "sine", 0.04); tone(392, 0.26, "sine", 0.035, 0.05); },
  // a habit kept: a light, bright pair
  habit: ({ bell }) => { bell(783.99, 0.9, 0.06); bell(1174.66, 1.1, 0.045, 0.07); },
  // a new level: a rising bell chord
  level: ({ bell }) => [587.33, 739.99, 880, 1174.66, 1479.98].forEach((f, i) => bell(f, 2.2, 0.1, i * 0.14)),
  // something captured or created: a soft tap
  add: ({ tone }) => { tone(1046.5, 0.055, "sine", 0.05); tone(1567.98, 0.04, "sine", 0.025, 0.012); },
  // moved to trash: paper brushed away, then a low note
  trash: ({ tone, noise }) => { noise(0.18, 0.05, 0, 1400, 6000); tone(523.25, 0.12, "triangle", 0.04, 0.02); tone(349.23, 0.24, "sine", 0.045, 0.07); },
};

/** Play a named sound at `volume` 0..1 (quietly skipped if audio is unavailable). */
export function playSound(name, volume = 0.35) {
  const make = SOUNDS[name];
  if (!make || volume <= 0) return;
  const now = performance.now();
  if (now - last < 40) return; // a burst of changes sounds once
  last = now;
  try {
    if (!audio(volume)) return;
    make(voice(ac.currentTime));
    // the audio engine rests once the sound is over (the longest is under 3 s); the next one wakes it
    clearTimeout(idle);
    idle = setTimeout(() => { if (ac && ac.state === "running") ac.suspend().catch(() => {}); }, 4000);
  } catch {}
}

export const SOUND_NAMES = Object.keys(SOUNDS);
