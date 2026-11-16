// The player a note shows for ![[clip.mp4]] and ![[song.mp3]]: its own
// controls (the browser's differ from one engine to the next, and cannot be
// styled), a few settings, and time stamps that land in the note as links.

import { icon } from "./icons.js";
import { foldSections } from "./ui.js";

export const PLAYER_DEFAULTS = { controls: "hover", tint: "accent", round: 12, loop: false, muted: false, resume: true, speed: 1, cinema: false, wheel: false };
export const TINTS = { accent: "var(--accent)", red: "#ff3d3d", white: "#f4f4f5", green: "#3ddc84", blue: "#4c9aff", pink: "#ff6fb5" };
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
const POS_KEY = "leonote.noteplayer.pos";

export const clock = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
/** "1:23", "1:02:03", "83" or "83s" as seconds; null when it is none of them. */
export function parseClock(t) {
  t = String(t || "").trim().replace(/s$/i, "");
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(t)) return null;
  return t.split(":").reduce((a, p) => a * 60 + parseFloat(p), 0);
}

const AR_KEY = "leonote.noteplayer.shape";
let arMap = null;
function shapes() {
  if (!arMap) { try { arMap = new Map(JSON.parse(localStorage.getItem(AR_KEY) || "[]")); } catch { arMap = new Map(); } }
  return arMap;
}
let posMap = null;
function positions() {
  if (!posMap) { try { posMap = new Map(JSON.parse(localStorage.getItem(POS_KEY) || "[]")); } catch { posMap = new Map(); } }
  return posMap;
}
let posTimer = 0;
function savePos(path, t) {
  const m = positions();
  m.delete(path);
  if (t > 2) m.set(path, Math.floor(t));
  clearTimeout(posTimer);
  posTimer = setTimeout(() => { try { localStorage.setItem(POS_KEY, JSON.stringify([...m].slice(-300))); } catch {} }, 1200);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => {
  for (const w of document.querySelectorAll(".cm-media")) if (w._player && !w._player.media.paused) positions().set(w._player.path, Math.floor(w._player.media.currentTime));
  try { localStorage.setItem(POS_KEY, JSON.stringify([...positions()].slice(-300))); } catch {}
});

const el = (tag, cls, ...kids) => { const n = document.createElement(tag); if (cls) n.className = cls; n.append(...kids); return n; };

/** Every player a note is showing right now, by the file it plays. */
export function playersFor(root, path) {
  return [...root.querySelectorAll(".cm-media")].filter((w) => w._player && w._player.path === path).map((w) => w._player);
}

/**
 * Build the player inside `wrap` (a span.cm-media).
 * o: { hit: { url, path, audio, name }, settings(), setSetting(k, v), onStamp(seconds), editorRoot() }
 */
export function buildPlayer(wrap, o) {
  const { url, path, audio, name } = o.hit;
  const S = () => ({ ...PLAYER_DEFAULTS, ...(o.settings ? o.settings() : {}) });
  const media = document.createElement(audio ? "audio" : "video");
  media.preload = "metadata";
  media.crossOrigin = "anonymous";
  media.src = url;
  if (!audio) media.playsInline = true;
  media.tabIndex = -1;

  const btn = (ico, title, run, cls = "") => {
    const b = el("button", "nv-btn " + cls, icon(ico));
    b.type = "button";
    b.title = title;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); run(e, b); });
    return b;
  };
  const swap = (b, ico, title) => { b.replaceChildren(icon(ico)); if (title) b.title = title; };

  const play = btn("playSolid", "Play", () => toggle(), "nv-play");
  const time = el("span", "nv-time", "0:00");
  const seek = el("span", "nv-seek", el("span", "nv-seek-rail", el("span", "nv-seek-buf"), el("span", "nv-seek-fill")), el("span", "nv-seek-knob"));
  const bubble = el("span", "nv-bubble");
  seek.append(bubble);
  const vol = btn("volume", "Mute", () => { media.muted = !media.muted; if (!media.muted && media.volume === 0) media.volume = 0.6; });
  const volRange = el("input", "nv-vol-range");
  volRange.type = "range"; volRange.min = 0; volRange.max = 1; volRange.step = 0.02; volRange.value = 1;
  volRange.title = "Volume";
  volRange.addEventListener("input", () => { media.volume = +volRange.value; media.muted = +volRange.value === 0; });
  for (const t of ["mousedown", "click", "pointerdown"]) volRange.addEventListener(t, (e) => e.stopPropagation());
  const volBox = el("span", "nv-vol", vol, volRange);
  const speed = el("button", "nv-btn nv-speed", "1×");
  speed.type = "button";
  speed.title = "Speed · click for the next one, right-click for the one before";
  const step = (d) => { const i = SPEEDS.indexOf(media.playbackRate); media.playbackRate = SPEEDS[((i < 0 ? 2 : i) + d + SPEEDS.length) % SPEEDS.length]; };
  speed.addEventListener("mousedown", (e) => e.preventDefault());
  speed.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); step(1); });
  speed.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); step(-1); });
  const stamp = btn("clock", "Put this moment in the note (a link that jumps back here)", () => o.onStamp && o.onStamp(media.currentTime), "nv-stamp");
  const loop = btn("repeat", "Loop", () => { media.loop = !media.loop; loop.classList.toggle("is-on", media.loop); }, "nv-loop");
  const gear = btn("settings", "Player settings", (e, b) => openSettings(b));
  const pip = audio || !document.pictureInPictureEnabled ? null : btn("pip", "Picture in picture", () => (document.pictureInPictureElement ? document.exitPictureInPicture() : media.requestPictureInPicture()).catch(() => {}), "nv-pip");
  const full = audio ? null : btn("fullscreen", "Full screen · double-click", () => fullscreen());

  const row = el("span", "nv-row", play, time, el("span", "nv-gap"), stamp, loop, volBox, speed, gear, ...(pip ? [pip] : []), ...(full ? [full] : []));
  const box = el("span", "nv-box");
  if (audio) {
    const title = el("span", "nv-title", icon("music"), document.createTextNode(name.replace(/\.[^.]+$/, "")));
    box.append(media, title, seek, row);
  } else {
    const big = el("span", "nv-big", icon("playSolid"));
    box.append(media, big, el("span", "nv-ctl", seek, row));
  }
  wrap.append(box);

  /* ── state ── */
  let shown = "";
  const paint = () => {
    const d = media.duration || 0;
    const p = d ? media.currentTime / d : 0;
    seek.style.setProperty("--p", (p * 100).toFixed(2) + "%");
    let b = 0;
    try { for (let i = 0; i < media.buffered.length; i++) if (media.buffered.start(i) <= media.currentTime + 0.5) b = Math.max(b, media.buffered.end(i)); } catch {}
    seek.style.setProperty("--b", (d ? (b / d) * 100 : 0).toFixed(2) + "%");
    const label = clock(media.currentTime) + "|" + clock(d);
    if (label !== shown) { shown = label; time.replaceChildren(clock(media.currentTime), ...(d ? [el("span", "nv-dur", " / " + clock(d))] : [])); }
  };
  const paintPlay = () => {
    const on = !media.paused && !media.ended;
    swap(play, on ? "pauseSolid" : "playSolid", on ? "Pause" : "Play");
    wrap.classList.toggle("is-playing", on);
    const root = o.editorRoot && o.editorRoot();
    if (root) root.classList.toggle("nv-cinema", !audio && S().cinema && !!root.querySelector(".cm-media.is-video.is-playing"));
  };
  const paintVol = () => {
    const v = media.muted ? 0 : media.volume;
    swap(vol, v === 0 ? "volumeOff" : v < 0.5 ? "volumeLow" : "volume", media.muted ? "Unmute" : "Mute");
    volRange.value = v;
    volRange.style.setProperty("--p", v * 100 + "%");
  };
  const paintSpeed = () => { speed.textContent = String(media.playbackRate).replace(/^0\./, ".") + "×"; speed.classList.toggle("is-on", media.playbackRate !== 1); };

  function toggle() {
    if (media.paused || media.ended) {
      // one thing plays at a time in a note
      const root = o.editorRoot && o.editorRoot();
      if (root) for (const m of root.querySelectorAll(".cm-media video, .cm-media audio")) if (m !== media) m.pause();
      media.play().catch(() => {});
    } else media.pause();
  }
  function fullscreen() {
    // the note's own viewer, when there is one: its arrows, its menu and the note's pictures around it
    if (!document.fullscreenElement && o.onFullscreen) { media.pause(); return o.onFullscreen(media.currentTime); }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else box.requestFullscreen().catch(() => {});
  }
  function applySettings() {
    const s = S();
    wrap.dataset.controls = s.controls;
    wrap.style.setProperty("--nv-tint", TINTS[s.tint] || TINTS.accent);
    wrap.style.setProperty("--nv-round", Math.max(0, Math.min(28, +s.round || 0)) + "px");
    if (o.onResize && wrap.isConnected) o.onResize(); // "below" makes it taller
  }
  // the video's shape, known from the last time: the note does not jump when it
  // loads. When the shape does change the height, the editor is told, or its
  // idea of where the lines are (and so where a click lands) goes stale.
  function setShape(ar) {
    const before = wrap.offsetHeight;
    wrap.style.setProperty("--ar", String(ar));
    wrap.classList.toggle("is-tall", ar < 1);
    if (o.onResize && wrap.isConnected && wrap.offsetHeight !== before) o.onResize();
  }
  if (!audio && shapes().has(path)) setShape(shapes().get(path));
  const s0 = S();
  media.loop = !!s0.loop;
  media.muted = !!s0.muted;
  media.defaultPlaybackRate = media.playbackRate = SPEEDS.includes(+s0.speed) ? +s0.speed : 1;
  loop.classList.toggle("is-on", media.loop);
  applySettings();

  media.addEventListener("loadedmetadata", () => {
    const at = S().resume ? positions().get(path) : 0;
    if (at && media.duration && at < media.duration - 3 && media.currentTime < 1) media.currentTime = at;
    if (!audio && media.videoWidth && media.videoHeight) {
      const ar = +(media.videoWidth / media.videoHeight).toFixed(4);
      if (shapes().get(path) !== ar) { shapes().set(path, ar); try { localStorage.setItem(AR_KEY, JSON.stringify([...shapes()].slice(-400))); } catch {} }
      setShape(ar);
    }
    paint();
  });
  // where it stopped is written on pause, on leaving the note and on closing the app - never on a timer while it plays
  media.addEventListener("timeupdate", paint);
  media.addEventListener("progress", paint);
  media.addEventListener("seeked", paint);
  for (const t of ["play", "pause", "ended"]) media.addEventListener(t, paintPlay);
  media.addEventListener("pause", () => savePos(path, media.ended ? 0 : media.currentTime));
  media.addEventListener("ended", () => savePos(path, 0));
  media.addEventListener("volumechange", paintVol);
  media.addEventListener("ratechange", paintSpeed);
  media.addEventListener("error", () => { wrap.classList.add("is-broken"); time.textContent = "cannot play this file"; });
  paintVol(); paintSpeed(); paint();

  /* ── the seek bar: follows the pointer itself ── */
  const ratio = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))); };
  seek.addEventListener("pointermove", (e) => {
    const d = media.duration || 0;
    if (!d) return;
    const q = ratio(e);
    bubble.textContent = clock(q * d);
    bubble.style.left = q * 100 + "%";
  });
  seek.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
  seek.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
  seek.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !media.duration) return;
    e.preventDefault();
    e.stopPropagation();
    try { seek.setPointerCapture(e.pointerId); } catch {}
    seek.classList.add("is-drag");
    const go = (ev) => { media.currentTime = ratio(ev) * media.duration; paint(); };
    go(e);
    const move = (ev) => (ev.buttons ? go(ev) : up());
    const up = () => { seek.classList.remove("is-drag"); seek.removeEventListener("pointermove", move); for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) seek.removeEventListener(t, up); };
    seek.addEventListener("pointermove", move);
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) seek.addEventListener(t, up);
  });

  // the wheel over the controls: volume; over the seek bar: five seconds
  box.addEventListener("wheel", (e) => {
    if (e.ctrlKey || !S().wheel) return;
    const onSeek = e.target.closest && e.target.closest(".nv-seek");
    const onCtl = e.target.closest && e.target.closest(".nv-row, .nv-vol");
    if (!onSeek && !onCtl) return;
    e.preventDefault();
    if (onSeek) media.currentTime = Math.max(0, Math.min(media.duration || 0, media.currentTime + (e.deltaY < 0 ? 5 : -5)));
    else { media.muted = false; media.volume = Math.max(0, Math.min(1, media.volume + (e.deltaY < 0 ? 0.05 : -0.05))); }
  }, { passive: false });

  // controls step back while a video plays and the pointer rests
  let idle = 0;
  const wake = () => { wrap.classList.remove("is-idle"); clearTimeout(idle); idle = setTimeout(() => { if (!media.paused && !pop) wrap.classList.add("is-idle"); }, 2200); };
  if (!audio) { box.addEventListener("pointermove", wake); box.addEventListener("pointerleave", () => { clearTimeout(idle); wrap.classList.remove("is-idle"); }); }

  /* ── settings ── */
  let pop = null;
  function closeSettings() { if (pop) { pop.remove(); pop = null; document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); } }
  const away = (e) => { if (pop && !pop.contains(e.target) && !gear.contains(e.target)) closeSettings(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeSettings(); } };
  function openSettings(anchor) {
    if (pop) return closeSettings();
    pop = el("div", "nv-pop");
    const set = (k, v) => { if (o.setSetting) o.setSetting(k, v); for (const w of document.querySelectorAll(".cm-media")) if (w._player) w._player.applySettings(); fill(); };
    const fill = () => {
      const s = S();
      const seg = (label, key, pairs) => el("div", "nv-pop-row", el("span", "nv-pop-label", label), el("span", "nv-seg", ...pairs.map(([v, text]) => {
        const b = el("button", "nv-seg-btn" + (s[key] === v ? " is-on" : ""), text);
        b.type = "button";
        b.onclick = () => set(key, v);
        return b;
      })));
      const check = (label, key, hint, after) => {
        const b = el("button", "nv-check" + (s[key] ? " is-on" : ""), el("span", "nv-check-box", icon("check")), el("span", "nv-check-text", label, ...(hint ? [el("small", "", hint)] : [])));
        b.type = "button";
        b.onclick = () => { set(key, !s[key]); if (after) after(!s[key]); };
        return b;
      };
      const tints = el("span", "nv-tints", ...Object.entries(TINTS).map(([k, c]) => {
        const b = el("button", "nv-tint" + (s.tint === k ? " is-on" : ""));
        b.type = "button";
        b.title = k === "accent" ? "The theme's colour" : k;
        b.style.setProperty("--c", c);
        b.onclick = () => set("tint", k);
        return b;
      }));
      const round = el("input", "nv-pop-range");
      round.type = "range"; round.min = 0; round.max = 28; round.step = 1; round.value = s.round;
      round.oninput = () => { if (o.setSetting) o.setSetting("round", +round.value); for (const w of document.querySelectorAll(".cm-media")) if (w._player) w._player.applySettings(); };
      pop.replaceChildren(
        el("div", "nv-pop-head", "Players in notes"),
        foldSections([
          { title: "Look", icon: "palette", open: true, body: [
            seg("Controls", "controls", [["hover", "On hover"], ["always", "Always"], ["below", "Below"]]),
            el("div", "nv-pop-row", el("span", "nv-pop-label", "Colour"), tints),
            el("div", "nv-pop-row", el("span", "nv-pop-label", "Corners"), round)] },
          { title: "Playing", icon: "play", body: [
            seg("Starting speed", "speed", [[1, "1×"], [1.25, "1.25×"], [1.5, "1.5×"], [2, "2×"]]),
            check("Carry on where I stopped", "resume", "remembered per file, on this computer"),
            check("Loop", "loop", null, (v) => { media.loop = v; loop.classList.toggle("is-on", v); }),
            check("Start muted", "muted"),
            check("Dim the note while a video plays", "cinema", null, paintPlay),
            check("Wheel over the controls", "wheel", "volume; over the bar, five seconds")] },
        ], "leonote.noteplayer.sections"),
        el("div", "nv-pop-foot", "Click the player to pick it. Then Enter plays, Shift ← → moves five seconds, Shift ↑ ↓ sets the volume, and the corners resize it."));
    };
    fill();
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
    pop.style.top = (r.top - h - 8 > 8 ? r.top - h - 8 : Math.min(window.innerHeight - h - 8, r.bottom + 8)) + "px";
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
  }

  const player = {
    path, media, box, toggle, fullscreen, applySettings,
    seek: (t, andPlay) => { const go = () => { media.currentTime = Math.max(0, Math.min(media.duration || t, t)); if (andPlay && media.paused) toggle(); }; if (media.readyState >= 1) go(); else { media.addEventListener("loadedmetadata", go, { once: true }); media.load(); } },
    stamp: () => o.onStamp && o.onStamp(media.currentTime),
    /** A key pressed while this player is the picked one. */
    key(k) {
      switch (k) {
        case "ArrowLeft": media.currentTime = Math.max(0, media.currentTime - 5); return true;
        case "ArrowRight": media.currentTime = Math.min(media.duration || 0, media.currentTime + 5); return true;
        case "ArrowUp": media.muted = false; media.volume = Math.min(1, media.volume + 0.05); return true;
        case "ArrowDown": media.volume = Math.max(0, media.volume - 0.05); return true;
      }
      return false;
    },
    destroy() { closeSettings(); clearTimeout(idle); savePos(path, media.ended ? 0 : media.currentTime); try { media.pause(); media.removeAttribute("src"); media.load(); } catch {} },
  };
  wrap._player = player;
  return player;
}
