// The player engine: one queue for vault music, videos and online media, playing
// in the background while you work in other tabs. Each file gets one media
// element for the session; wherever it is shown (its file tab, the Player
// view) the same element moves there, and a hidden dock keeps it alive in
// between (a media element taken out of the page would stop). A small "now
// playing" pill in the status bar controls it from anywhere. Positions of
// long files are remembered; OS media keys work through the Media Session.

import { h, debounce, keyOf } from "./util.js";
import { icon } from "./icons.js";
import * as Q from "./playqueue.js";
import { peekMeta, guessMeta, loadMeta, folderCover, coverUrl } from "./mediameta.js";

export const AUDIO = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;
const POS_KEY = "leonote.media.pos";
const QUEUE_KEY = "leonote.player.queue";
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const RESUME_MIN = 8 * 60; // only long files pick up where they stopped

export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return (hh ? `${hh}:${String(mm).padStart(2, "0")}` : `${mm}`) + ":" + String(s % 60).padStart(2, "0");
};

/** Where a key's bytes come from: the vault, a library folder, or the web. */
export function srcUrl(app, key) {
  if (Q.isUrl(key)) return Q.urlOf(key);
  if (Q.isLib(key)) {
    const e = app.media && app.media.libraries.entry(key);
    // a file outside the vault that no library lists: played from where it lies
    const abs = e ? e.abs : app.media && app.media.outsideAbs(key);
    return abs ? app.host.assetAbs(abs) : "";
  }
  return app.host.assetUrl(key);
}

export function createMedia(app) {
  const players = new Map(); // path -> { el, path, audio, home, autoNext, owned }
  const bus = new EventTarget();
  // a run of changes (a playlist read from YouTube) says "library" once, at its end: one redraw, not one a step
  let holding = 0, held = false;
  const emit = (type) => { if (holding && type === "library") { held = true; return; } bus.dispatchEvent(new Event(type)); };
  async function batch(fn) {
    holding++;
    try { return await fn(); } finally { if (!--holding && held) { held = false; emit("library"); } }
  }
  /* A file opened (from the files, or from Explorer) while something plays: it plays at once, ahead of
     what was on, and leaves the queue when it is done or skipped - Next is what was playing, where it was.
     Settings › Player › A file opened while something plays › Joins the queue keeps it there instead. */
  const temps = new Set();
  function dropTemps() {
    if (!temps.size) return;
    const now = Q.current(queue);
    let any = false;
    for (const k of [...temps]) {
      if (k === now || (cur && cur.key === k)) continue;
      const i = queue.items.indexOf(k);
      if (i >= 0) { Q.remove(queue, i); any = true; }
      temps.delete(k);
    }
    if (any) queueChanged();
  }
  const changed = () => { dropTemps(); emit("change"); };
  const dock = h("div", { class: "media-dock", "aria-hidden": "true" });
  document.body.append(dock);
  const S = app.settings;
  const pref = (k, d) => (S[k] === undefined ? d : S[k]);
  const saveLater = {};
  const savePref = (k, v) => (saveLater[k] || (saveLater[k] = debounce((x) => app.setSetting(k, x), 600)))(v);

  let positions = {};
  try { positions = JSON.parse(localStorage.getItem(POS_KEY) || "{}") || {}; } catch {}
  const writePositions = () => {
    const keys = Object.keys(positions);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete positions[k];
    try { localStorage.setItem(POS_KEY, JSON.stringify(positions)); } catch {}
  };
  // what plays asks several times a second: written at most every 5 s while it plays (a debounce would wait for a
  // quiet moment that never comes until it stops, so a quit mid-song lost the place), and at once as the window goes
  let posT = 0;
  const savePositions = () => { if (!posT) posT = setTimeout(() => { posT = 0; writePositions(); }, 5000); };
  savePositions.flush = () => { clearTimeout(posT); posT = 0; writePositions(); };

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(QUEUE_KEY) || "null"); } catch {}
  const queue = Q.createQueue(saved);
  const saveQueue = debounce(() => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(Q.snapshot(queue))); } catch {} }, 400);
  const queueChanged = () => { saveQueue(); emit("queue"); };

  let volume = +pref("playerVolume", 1);
  let muted = !!pref("playerMuted", false);
  let rate = +pref("playerRate", 1) || 1;
  // what is playing (or paused, ready to resume): { key, p } for a file, { key, yt: id } for YouTube
  let cur = null;
  const carried = new Set(); // keys resumed from the last session
  let started = false; // anything played this session (the pill stays out of the way until then)

  /* ── vault files ─────────────────────────────────────────────────────── */
  // `path` is a vault path, or "url:…" for a direct link to a media file
  function player(path) {
    let p = players.get(path);
    if (p) return p;
    const remote = Q.isUrl(path);
    const audio = remote ? !!(Q.parseDirect(Q.urlOf(path)) || {}).audio : AUDIO.test(Q.isLib(path) ? Q.libPath(path) : path);
    const el = h(audio ? "audio" : "video", { class: "fv-media " + (audio ? "fv-audio" : "fv-video"), preload: "metadata", playsInline: true });
    // same-origin for Web Audio (the asset protocol answers with CORS headers);
    // other sites may not, and asking would stop them playing at all
    if (!remote) el.crossOrigin = "anonymous";
    el.src = srcUrl(app, path);
    el.volume = volume;
    el.muted = muted;
    p = { el, path, audio, remote, home: null, autoNext: pref("playerAutoNext", true) !== false, owned: false };
    el.addEventListener("loadedmetadata", () => {
      const at = positions[path];
      // a song carried over from the last session picks up where it stopped, however short
      if (at && at > 3 && at < el.duration - 5 && (el.duration > RESUME_MIN || !audio || carried.delete(path))) el.currentTime = at;
      if (cur && cur.p === p) changed();
    }, { once: true });
    el.addEventListener("play", () => adopt(p));
    el.addEventListener("pause", () => { if (cur && cur.p === p) changed(); });
    el.addEventListener("ended", () => {
      delete positions[path];
      savePositions();
      if (!cur || cur.p !== p) return changed();
      if (sleepEnd) { sleepEnd = false; changed(); return emit("sleep"); }
      if (p.autoNext && queue.repeat !== "one" && !p.owned) return step(p, 1, "auto");
      next({ auto: true });
    });
    el.addEventListener("timeupdate", () => {
      if (el.duration > RESUME_MIN || !audio) { positions[path] = Math.round(el.currentTime); savePositions(); }
      if (cur && cur.p === p) tick();
    });
    el.addEventListener("volumechange", () => {
      if (!cur || cur.p !== p || (el.volume === volume && el.muted === muted)) return;
      volume = el.volume; muted = el.muted;
      savePref("playerVolume", volume); if (S.playerMuted !== muted) app.setSetting("playerMuted", muted);
      emit("levels");
    });
    el.addEventListener("error", () => {
      if (remote && cur && cur.p === p) {
        app.toast("This link didn't play here (the site may block it, or it's offline)", { kind: "error", ms: 7000, action: { label: "Open original", run: () => (app.playerOpenHere ? app.playerOpenHere(Q.urlOf(path)) : app.openUrl(Q.urlOf(path))) } });
        if (queue.items.length > 1) setTimeout(() => next({ auto: true }), 1200);
        return;
      }
      if (cur && cur.p === p && p.owned) {
        // said once, in plain words, with where it was meant to be (the play() refusal stays quiet: this says it)
        p.failSaid = Date.now();
        const name = path.slice(path.lastIndexOf("/") + 1);
        const more = queue.items.length > 1;
        app.toast(`${name} could not be played - moved, its drive not connected, or a kind of file the player cannot read${more ? " · skipping" : ""}`, { kind: "error", ms: 6000,
          // the folder it was in (the file itself may be gone)
          action: Q.isUrl(path) ? null : { label: "Show the folder", run: () => {
            if (!Q.isLib(path)) return app.reveal(path.slice(0, path.lastIndexOf("/")) || path);
            const abs = Q.libPath(path);
            app.host.externalReveal(abs.slice(0, Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/")))).catch(() => app.toast("That folder is not there either - its drive may be out", { ms: 2600 }));
          } } });
        if (more) next({ auto: true });
      }
    });
    players.set(path, p);
    return p;
  }

  // a file started from its own controls (file tab) joins the queue
  function adopt(p) {
    started = true;
    if (p.path === anchorKey) anchorKey = null; // the playlist is back on its song
    if (cur && cur.p === p) { stopOthers(p.path); changed(); return; }
    stopOthers(p.path);
    leaveYt();
    if (Q.current(queue) !== p.path) {
      const i = queue.items.indexOf(p.path);
      // not in the queue yet: in for as long as it plays (unless opened files join the queue)
      if (i < 0 && !pref("playerOpenedJoins", false) && queue.items.length) temps.add(p.path);
      Q.go(queue, i >= 0 ? i : insertAhead(p.path));
      queueChanged();
    }
    cur = { key: p.path, p };
    applyLevels();
    graphJoin();
    changed();
  }

  // Songs picked from the files while a playlist plays line up, in the order
  // they were picked, just AHEAD of the playlist song that was on (the
  // anchor): a, b, [picked 1, picked 2, picked 3], ANCHOR, d... So Next from
  // the last one picked is the playlist again, exactly where it was left.
  // The anchor holds until the queue itself reaches it, or is replaced.
  let anchorKey = null;
  function insertAhead(path) {
    if (anchorKey == null || queue.items.indexOf(anchorKey) < 0) anchorKey = Q.current(queue) ?? null;
    const at = anchorKey == null ? -1 : queue.items.indexOf(anchorKey);
    return at >= 0 ? Q.insert(queue, [path], { at }) : Q.insert(queue, [path], { next: true });
  }

  function stopOthers(keep) {
    for (const q of players.values()) if (q.path !== keep && !q.el.paused) q.el.pause();
  }
  // a file takes over from YouTube: its video goes quiet and out of sight
  function leaveYt() {
    if (!yt || !cur || !cur.yt) return;
    yt.pause();
    yt.hide();
    ytPlaying = false;
    clearInterval(ytTimer);
  }

  // the same kind of files in the folder, for the file tab's previous / next
  // files outside the vault, opened in a tab: key -> the path on disk, and
  // the playable files beside each, as the tab found them
  const outside = new Map();
  const outsideBeside = new Map(); // "lib:E:/Music/" -> [keys]
  function outsideKey(abs, besideAbs = []) {
    const key = Q.libKey(abs);
    outside.set(key, abs);
    const keys = besideAbs.map((a) => { const k = Q.libKey(a); outside.set(k, a); return k; });
    if (keys.length) outsideBeside.set(key.slice(0, key.lastIndexOf("/") + 1), keys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    return key;
  }
  function siblings(path) {
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    if (Q.isLib(path)) return outsideBeside.get(dir) || [path];
    return [...app.vault.files.values()].filter((f) => f.kind === "media" && f.path.startsWith(dir) && !f.path.slice(dir.length).includes("/"))
      .map((f) => f.path).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  // Through the folder: in order or shuffled, and round again at the end if
  // asked. A shuffle deals every file once before any comes up twice.
  const dealt = new Map(); // folder -> files already played in this shuffle
  function step(p, d, autoplay) {
    const list = siblings(p.path);
    let nxt;
    if (pref("playerFolderShuffle", false) && list.length > 2) {
      const dir = p.path.slice(0, p.path.lastIndexOf("/") + 1);
      let seen = dealt.get(dir);
      if (!seen) dealt.set(dir, (seen = new Set()));
      seen.add(p.path);
      let left = list.filter((x) => !seen.has(x));
      if (!left.length) {
        if (!pref("playerFolderLoop", false) && d > 0 && autoplay === "auto") return;
        seen.clear();
        seen.add(p.path);
        left = list.filter((x) => x !== p.path);
      }
      nxt = left[Math.floor(Math.random() * left.length)];
    } else {
      const i = list.indexOf(p.path) + d;
      nxt = list[i];
      if (!nxt && pref("playerFolderLoop", false) && list.length > 1) nxt = list[(i + list.length) % list.length];
    }
    if (!nxt) return;
    p.el.pause();
    const q = player(nxt);
    q.autoNext = p.autoNext;
    const fs = document.fullscreenElement && document.fullscreenElement.classList.contains("mp-unit") ? document.fullscreenElement.parentNode : null;
    if (t && t.kind === "file" && t.path === p.path) app.openFile(nxt);
    else if (t && t.kind === "ext" && Q.libKey(t.path) === p.path && outside.has(nxt)) app.openExternal(outside.get(nxt));
    if (fs && !q.audio) requestAnimationFrame(() => { const u = q.el.closest(".mp-unit"); if (u && u.requestFullscreen) u.requestFullscreen().catch(() => {}); });
    if (autoplay) q.el.play().catch(() => {});
  }

  /** The player for a file tab: the element plus a control strip. */
  function view(path) {
    const p = player(path);
    const { el } = p;
    // Opened from the files while the player has something going: it takes
    // its place in the queue at once - next in line, not started for you -
    // so the pill knows it, and nothing drops out of sight when the tab
    // moves on to another file.
    if (pref("playerOpenedJoins", false) && (cur || queue.items.length) && queue.items.indexOf(path) < 0) { insertAhead(path); queueChanged(); }
    const btn = (ic, title, run, cls) => h("button", { class: "mp-btn" + (cls ? " " + cls : ""), title, onclick: run }, icon(ic));
    // whatever an earlier view of this file hung on the element goes with that view
    if (p.viewOff) p.viewOff.abort();
    p.viewOff = new AbortController();
    const sig = { signal: p.viewOff.signal };
    const speed = h("button", { class: "mp-speed", title: "Playback speed - presets and a fine slider", onclick: (e) => speedPop(e.currentTarget, { get: () => el.playbackRate, set: (r) => { setRate(r, p); paint(); } }) });
    // One button, three states: off -> the folder round again -> this file over and over -> off
    const repeatState = () => (el.loop ? "one" : pref("playerFolderLoop", false) ? "all" : "off");
    const loop = btn("repeat", "", () => {
      const next = { off: "all", all: "one", one: "off" }[repeatState()];
      el.loop = next === "one";
      S.playerFolderLoop = next === "all";
      savePref("playerFolderLoop", S.playerFolderLoop);
      paint();
    });
    const mix = btn("shuffle", "Shuffle the folder: next is a file picked at random, each once before any repeats", () => { S.playerFolderShuffle = !pref("playerFolderShuffle", false); savePref("playerFolderShuffle", S.playerFolderShuffle); paint(); });
    const chain = btn("autoNext", "Carry on through the folder: play the next file when this one ends", () => { p.autoNext = !p.autoNext; p.owned = false; savePref("playerAutoNext", p.autoNext); paint(); });
    const pip = !p.audio && document.pictureInPictureEnabled ? btn("pip", "Picture in picture", () => togglePip(el)) : null;
    const toPlayer = (wholeFolder) => {
      const all = wholeFolder ? siblings(path) : [path];
      if (wholeFolder && all.length > 1) playList(all, Math.max(0, all.indexOf(path)));
      else if (Q.current(queue) !== path) enqueue([path], { next: true });
      app.openView("music");
    };
    const more = btn("settings", "Playback settings, queue, playlists", (e) => {
      const at = e.currentTarget.getBoundingClientRect();
      const name = path.slice(path.lastIndexOf("/") + 1);
      const sl = { at: sleepAt, track: sleepEnd };
      const r = Math.round(el.playbackRate * 100) / 100;
      app.menu(at.left - 160, at.top - 8, [
        { header: name },
        { label: `Speed · ${r}×`, icon: "clock", sub: [
          ...[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3].map((s) => ({ label: s + "×", checked: r === s, run: () => { setRate(s, p); paint(); } })),
          "sep",
          { label: "Fine control…", icon: "settings", run: () => speedPop(speed, { get: () => el.playbackRate, set: (x) => { setRate(x, p); paint(); } }) },
        ] },
        { label: "Repeat this file", icon: "repeat", checked: el.loop, run: () => { el.loop = !el.loop; paint(); } },
        { label: "Carry on through the folder", icon: "autoNext", checked: !!p.autoNext, run: () => chain.click() },
        { label: sl.track ? "Sleep · after this file" : sl.at ? `Sleep · ${Math.max(1, Math.round((sl.at - Date.now()) / 60000))} min left` : "Sleep timer", icon: "moon", sub: [
          { label: "Off", checked: !sl.at && !sl.track, run: () => setSleep(0) },
          ...[15, 30, 45, 60, 90].map((m) => ({ label: `${m} minutes`, run: () => setSleep(m) })),
          { label: "After this file", checked: sl.track, run: () => setSleep("track") },
        ] },
        "sep",
        { label: list.length > 1 ? `Continue in the Player · this folder (${list.length})` : "Continue in the Player", icon: "music", keys: "Alt 7", run: () => toPlayer(true) },
        list.length > 1 ? { label: "Continue in the Player · only this file", icon: "music", run: () => toPlayer(false) } : null,
        "sep",
        { label: "Play next", icon: "forward", run: () => { enqueue([path], { next: true }); app.toast("Plays next", { ms: 1600 }); } },
        { label: "Add to the queue", icon: "plus", run: () => { enqueue([path]); app.toast("Added to the queue", { ms: 1600 }); } },
        { label: "Add to a playlist", icon: "list", sub: [
          ...lists().map((pl) => ({ label: pl.name, icon: "list", checked: pl.items.includes(path), run: () => { playlists.add(pl.id, [path]); app.toast(`Added to ${pl.name}`, { ms: 1800 }); } })),
          lists().length ? "sep" : null,
          { label: "New playlist with this", icon: "plus", run: () => { const pl = playlists.create(name.replace(/\.[^.]+$/, ""), [path]); app.toast(`Playlist “${pl.name}” created - rename it in the Player`, { ms: 3000 }); } },
        ].filter(Boolean) },
        "sep",
        pip ? { label: "Picture in picture", icon: "pip", run: () => togglePip(el) } : null,
        { label: "Show in the file tree", icon: "folder", run: () => app.revealInTree && app.revealInTree(path) },
        { label: "Show in Explorer", icon: "reveal", run: () => app.reveal && app.reveal(path) },
      ].filter(Boolean));
    });
    const list = siblings(path);
    const i = list.indexOf(path);
    /* One strip, laid out the way players are: the seek bar across the top;
       under it the transport, the volume and the time on the left, and what
       changes how it plays on the right, ending in full screen. The browser's
       own controls are off - two sets of buttons was the odd part. */
    const swap = (b, name) => b.replaceChildren(icon(name));
    const playBtn = btn("playSolid", "Play / pause (K or Space)", () => { el.paused ? el.play().catch(() => {}) : el.pause(); }, "mp-play");
    const volBtn = btn("volume", "Mute (M)", () => { el.muted = !el.muted; });
    const vol = h("input", { type: "range", class: "mp-vol", min: 0, max: 1, step: 0.01, title: "Volume", "aria-label": "Volume" });
    vol.addEventListener("input", () => { el.muted = false; el.volume = Number(vol.value); });
    const timeEl = h("span", { class: "mp-time" });
    const seek = h("div", { class: "mp-seek", role: "slider", "aria-label": "Position", tabindex: "0" },
      h("div", { class: "mp-seek-rail" }, h("div", { class: "mp-seek-buf" }), h("div", { class: "mp-seek-fill" }), h("div", { class: "mp-seek-knob" })),
      h("div", { class: "mp-seek-tip" }));
    const [rail, seekTip] = seek.children;
    const fracAt = (e) => { const r = rail.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))); };
    let scrubbing = false;
    const tick = () => {
      const d = el.duration || 0;
      if (!scrubbing) seek.style.setProperty("--p", (d ? (el.currentTime / d) * 100 : 0) + "%");
      let b = 0;
      for (let n = 0; n < el.buffered.length; n++) if (el.buffered.start(n) <= el.currentTime + 1) b = Math.max(b, el.buffered.end(n));
      seek.style.setProperty("--b", (d ? (b / d) * 100 : 0) + "%");
      timeEl.textContent = fmtTime(el.currentTime) + " / " + (d && isFinite(d) ? fmtTime(d) : "--:--");
    };
    seek.addEventListener("pointermove", (e) => {
      const f = fracAt(e);
      seekTip.textContent = fmtTime(f * (el.duration || 0));
      seekTip.style.left = f * 100 + "%";
      if (scrubbing) { seek.style.setProperty("--p", f * 100 + "%"); if (el.duration) el.currentTime = f * el.duration; }
    });
    seek.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      scrubbing = true;
      seek.classList.add("is-scrub");
      seek.setPointerCapture(e.pointerId);
      const f = fracAt(e);
      seek.style.setProperty("--p", f * 100 + "%");
      if (el.duration) el.currentTime = f * el.duration;
    });
    const endScrub = () => { scrubbing = false; seek.classList.remove("is-scrub"); tick(); };
    seek.addEventListener("pointerup", endScrub);
    seek.addEventListener("pointercancel", endScrub);
    seek.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") el.currentTime = Math.max(0, el.currentTime - 5);
      else if (e.key === "ArrowRight") el.currentTime = Math.min(el.duration || 0, el.currentTime + 5);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    const fsBtn = p.audio ? null : btn("fullscreen", "Full screen (F, or double-click the video)", () => toggleFs());
    const paint = () => {
      speed.textContent = (Math.round(el.playbackRate * 100) / 100) + "×";
      const rs = repeatState();
      loop.classList.toggle("is-on", rs !== "off");
      swap(loop, rs === "one" ? "repeatOne" : "repeat");
      loop.title = rs === "one" ? "Repeating this file - press for no repeat" : rs === "all" ? "Round again: the folder starts over after its last file - press to repeat only this file" : "No repeat - press for the folder round again";
      chain.classList.toggle("is-on", !!p.autoNext);
      mix.classList.toggle("is-on", !!pref("playerFolderShuffle", false));
      swap(playBtn, el.paused ? "playSolid" : "pauseSolid");
      const v = el.muted ? 0 : el.volume;
      swap(volBtn, v === 0 ? "volumeOff" : v < 0.5 ? "volumeLow" : "volume");
      vol.value = String(v);
      vol.style.setProperty("--p", v * 100 + "%");
      tick();
    };
    for (const ev of ["play", "pause", "volumechange", "ratechange", "loadedmetadata", "durationchange", "emptied"]) el.addEventListener(ev, paint, sig);
    for (const ev of ["timeupdate", "progress", "seeked"]) el.addEventListener(ev, tick, sig);
    const prevBtn = btn("skipPrev", "Previous file in the folder (Up)", () => step(p, -1, !el.paused));
    const nextBtn = btn("skipNext", "Next file in the folder (Down)", () => step(p, 1, !el.paused));
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i < 0 || i >= list.length - 1;
    const bar = h("div", { class: "mp-bar" },
      seek,
      h("div", { class: "mp-row" },
        prevBtn, playBtn, nextBtn,
        btn("seekBack", "Back 10 seconds (J)", () => { el.currentTime = Math.max(0, el.currentTime - 10); }),
        btn("seekFwd", "Forward 10 seconds (L)", () => { el.currentTime = Math.min(el.duration || 0, el.currentTime + 10); }),
        h("span", { class: "mp-volbox" }, volBtn, vol),
        timeEl,
        h("span", { class: "mp-count", text: list.length > 1 ? `${i + 1} of ${list.length}` : "" }),
        h("span", { class: "mp-gap" }),
        list.length > 1 ? mix : null, chain, loop, speed,
        // the way to the big Player: the folder becomes the queue, the file carries on where it is
        h("button", { class: "mp-to-player", title: "Continue in the Player: queue, playlists, equalizer, theatre. The folder becomes the queue and this file carries on where it is (Alt+7)", onclick: () => toPlayer(true) }, icon("music"), h("span", { text: "Player" })),
        more, pip, fsBtn));
    const slot = h("div", { class: "mp-slot" }, el);
    const unit = h("div", { class: "mp-unit" + (p.audio ? " is-audio" : "") }, p.audio ? null : h("div", { class: "mp-stage" }, slot), bar);
    // full screen takes the strip along; it steps aside while the mouse rests
    let idleT = 0;
    const wake = () => {
      unit.classList.remove("is-idle");
      clearTimeout(idleT);
      if (document.fullscreenElement === unit) idleT = setTimeout(() => { if (!el.paused && !bar.matches(":hover")) unit.classList.add("is-idle"); }, 2400);
    };
    function toggleFs() {
      if (document.fullscreenElement === unit) document.exitFullscreen().catch(() => {});
      else if (unit.requestFullscreen) unit.requestFullscreen().catch(() => {});
    }
    unit.addEventListener("pointermove", wake);
    document.addEventListener("fullscreenchange", () => {
      const fs = document.fullscreenElement === unit;
      if (fsBtn) { swap(fsBtn, fs ? "fullscreenExit" : "fullscreen"); fsBtn.title = fs ? "Leave full screen (F or Esc)" : "Full screen (F, or double-click the video)"; }
      wake();
    }, sig);
    if (!p.audio) {
      // a click on the picture plays and pauses; two in a row is full screen, not two toggles
      let clickT = 0;
      slot.addEventListener("click", (e) => {
        if (e.target !== el) return;
        clearTimeout(clickT);
        clickT = setTimeout(() => { el.paused ? el.play().catch(() => {}) : el.pause(); }, 220);
      });
      slot.addEventListener("dblclick", (e) => { if (e.target === el) { clearTimeout(clickT); toggleFs(); } });
    }
    paint();
    const art = p.audio ? h("div", { class: "mp-art" }, icon("music")) : null;
    if (art) coverInto(art, path);
    // a song says what it is: title, then artist and album, filled in once the tags are read
    const titleEl = h("div", { class: "mp-title" });
    const subEl = h("div", { class: "mp-sub" });
    const sayWhat = () => { const m = metaOf(path); titleEl.textContent = m.title || path.slice(path.lastIndexOf("/") + 1); subEl.textContent = [m.artist, m.album].filter(Boolean).join(" · "); subEl.hidden = !subEl.textContent; };
    sayWhat();
    if (p.audio) Promise.resolve(metaReady(path)).then(sayWhat, () => {});
    const what = p.audio ? h("div", { class: "mp-what" }, titleEl, subEl) : null;
    const box = h("div", { class: "fv-body fv-center fv-player" + (p.audio ? " is-audio" : "") }, art, what, p.audio ? slot : null, unit);
    p.home = slot;
    el.controls = false;
    // keys while the player has focus: space, J/K/L, arrows
    box.tabIndex = -1;
    // a held arrow gathers pace: 5 seconds a step, then 15, then 30
    let held = 0;
    const jump = (dir, e) => {
      held = e.repeat ? held + 1 : 0;
      const by = held > 24 ? 30 : held > 8 ? 15 : 5;
      el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + dir * by));
    };
    box.addEventListener("keydown", (e) => {
      if (e.target.closest("button") && e.key === " ") return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.target.closest("input, textarea, select")) return;
      const k = keyOf(e).toLowerCase(); // the key, not the letter (a Ukrainian layout)
      if (k === "k" || k === " ") { el.paused ? el.play() : el.pause(); }
      else if (k === "m") el.muted = !el.muted;
      else if (k === "f" && !p.audio) toggleFs();
      else if (k === "arrowleft") jump(-1, e);
      else if (k === "arrowright") jump(1, e);
      // up and down step through the folder; with Shift they are the volume
      else if (k === "arrowup" && e.shiftKey) { el.muted = false; el.volume = Math.min(1, el.volume + 0.05); }
      else if (k === "arrowdown" && e.shiftKey) el.volume = Math.max(0, el.volume - 0.05);
      else if (k === "arrowup" || k === "arrowdown" || k === "pageup" || k === "pagedown") { if (!e.repeat) step(p, k === "arrowup" || k === "pageup" ? -1 : 1, !el.paused); }
      else if (k === "j") el.currentTime = Math.max(0, el.currentTime - 10);
      else if (k === "l") el.currentTime += 10;
      else if (k === "," && e.shiftKey) { setRate(Math.max(0.25, el.playbackRate - 0.25), p); paint(); }
      else if (k === "." && e.shiftKey) { setRate(Math.min(3, el.playbackRate + 0.25), p); paint(); }
      else return;
      e.preventDefault();
    });
    return box;
  }
  async function coverInto(box, path) {
    const f = app.vault.files.get(path);
    if (!f) return;
    const m = await loadMeta(app, f);
    const fc = folderCover(app, path);
    const url = m.cover || (fc ? coverUrl(app, fc) : "");
    if (url) { box.classList.add("has-cover"); box.replaceChildren(h("img", { src: url, alt: "" })); }
  }

  // a file tab came back: its element returns from wherever it was shown
  app.bus.on("view", (t) => {
    if (t && t.kind === "file") {
      const p = players.get(t.path);
      if (p && p.home && p.home.isConnected && p.el.parentNode !== p.home) { p.home.append(p.el); p.el.controls = false; }
    }
    if (t && t.kind === "view" && t.view === "music") return;
    // the YouTube video leaves the Player view with it: a small tile, or hidden
    if (cur && cur.yt && yt && yt.mode === "anchored") ytAway();
  });

  /** Before a file view redraws: keep any player inside it alive in the dock. */
  function park(container) {
    for (const el of container.querySelectorAll("video.fv-media, audio.fv-media")) {
      if (el.paused) el.remove();
      else dock.append(el);
    }
  }

  // the song before, when nothing shows it (a file tab keeps its own): let go, so a long evening of music does not
  // keep one player for every song it went through
  function letGo(p) { if (p && !(p.home && p.home.isConnected)) dispose(p.path); }

  function dispose(path) {
    const p = players.get(path);
    if (!p) return;
    // the queue is playing it - or it is simply what the pill shows, paused:
    // closing its tab only parks it, the pill keeps it
    if (cur && cur.p === p && (p.owned || queue.items.indexOf(path) >= 0)) { if (!p.owned) p.el.pause(); /* started from its tab: closing the tab still stops it */ if (p.el.parentNode !== dock && p.home && p.home.contains(p.el)) dock.append(p.el); p.home = null; return; }
    if (p.viewOff) p.viewOff.abort(); // its fullscreen listener held the whole player box
    if (audioGraph) audioGraph.detach(p.el);
    p.el.pause();
    p.el.removeAttribute("src");
    p.el.load();
    p.el.remove();
    players.delete(path);
    if (cur && cur.p === p) cur = null;
    changed();
  }

  /* ── YouTube ─────────────────────────────────────────────────────────── */
  let yt = null; // created on first YouTube play
  let ytMod = null;
  const GONE_FIX = Date.UTC(2026, 9, 7, 18);
  let ytPlaying = false;
  let ytBlockedAt = 0, ytBlockedN = 0, ytBlockedToast = null; // videos that play only on YouTube, skipped in a row
  let ytTimer = 0;
  let stage = null; // the Player view's placeholder for the video
  let ytTileHidden = false;
  // keeping to YouTube's player terms: YouTube never plays unseen. In the tray or minimized it pauses, and any play there is paused again
  const ytUnseen = () => Promise.all([app.host.win.isVisible(), app.host.win.isMinimized()]).then(([seen, small]) => !seen || small).catch(() => false);
  /* Out of sight, a playing video goes on in a small window of its own, on top of everything (ytmini.html), and
     comes back at the time it reached when Leonote is back; closing that window pauses it. `ytAside` while it is there. */
  let ytAside = null; // { key, id, at, playing }
  function ytToMini() {
    if (!cur || !cur.yt || !yt) return;
    const playing = !yt.paused();
    yt.pause();
    if (!playing || !app.host.ytMini) return;
    const next = { key: cur.key, id: cur.yt, at: yt.time(), playing: true, title: (metaOf(cur.key) || {}).title || "" };
    // the window is still open after its video ended: the next one plays on in it
    if (ytAside && ytAside.key === null) { ytAside = next; app.host.emitTo("ytmini", "ytmini:load", { id: next.id, start: next.at, play: true, title: next.title }).catch(() => {}); return; }
    if (ytAside) return;
    ytAside = next;
    app.host.ytMini(true).catch(() => { ytAside = null; });
  }
  /** The video back from its window: at the time it reached there, playing on if it was (`play`). */
  function ytBack(play) {
    const a = ytAside;
    if (!a) return;
    ytAside = null;
    app.host.ytMini(false).catch(() => {});
    if (!yt || !cur || cur.key !== a.key) return;
    yt.seek(a.at);
    if (play) yt.play();
    changed();
  }
  if (app.host.on) {
    app.host.on("app:hidden", ytToMini);
    app.host.on("ytmini:cmd", (p) => {
      const c = p && p.cmd;
      if (!ytAside) return;
      if (c === "hello") app.host.emitTo("ytmini", "ytmini:load", { id: ytAside.id, start: ytAside.at, play: true, title: ytAside.title }).catch(() => {});
      else if (c === "state" && Number.isFinite(Number(p.at))) { ytAside.at = Number(p.at); ytAside.playing = !!p.playing; }
      else if (c === "back") { if (Number.isFinite(Number(p.at))) ytAside.at = Number(p.at); const play = !!p.playing; app.host.win.show().catch(() => {}); ytBack(play); }
      else if (c === "closed" || c === "gone" || c === "error") { if (Number.isFinite(Number(p.at))) ytAside.at = Number(p.at); ytBack(false); }
      else if (c === "ended") {
        // the next in the queue: an online video goes on in this window, anything else plays here and the window goes
        const k = ytAside.key;
        ytAside.key = null;
        if (cur && cur.key === k) { delete positions[k]; next({ auto: true }); }
        setTimeout(() => { if (ytAside && ytAside.key === null && !(cur && cur.yt)) { ytAside = null; app.host.ytMini(false).catch(() => {}); } }, 3000);
      }
    });
    // Leonote back in sight: the video comes back to it, as it was there
    window.addEventListener("focus", () => { if (ytAside) ytBack(ytAside.playing); });
  }
  if (app.host.win && app.host.win.onResized) app.host.win.onResized(() => { if (cur && cur.yt && yt && !yt.paused()) ytUnseen().then((unseen) => { if (unseen && cur && cur.yt && yt) ytToMini(); }); }).catch(() => {});
  async function ytPlayer() {
    if (yt) return yt;
    ytMod = ytMod || (await import("./youtube.js"));
    if (yt) return yt;
    yt = ytMod.createYouTubePlayer({
      state: (s) => {
        if (!cur || !cur.yt) return;
        ytPlaying = s === "playing";
        clearInterval(ytTimer);
        if (ytPlaying) {
          started = true;
          for (const q of players.values()) if (!q.el.paused) q.el.pause();
          ytTimer = setInterval(() => {
            const t = yt.time();
            if (t > 30 && yt.duration() > RESUME_MIN) { positions[cur.key] = Math.round(t); savePositions(); }
            tick();
          }, 500);
          applyLevels();
          ytUnseen().then((unseen) => {
            if (!cur || !cur.yt) return;
            if (unseen) return ytToMini();
            // play pressed with the tile hidden brings the tile back
            if (ytTileHidden || yt.mode === "hidden") { ytTileHidden = false; app.setSetting("playerYtTileHidden", false); ytAway(); }
          });
        }
        if (s === "ended") {
          delete positions[cur.key];
          if (sleepEnd) { sleepEnd = false; changed(); return emit("sleep"); }
          next({ auto: true });
        }
        changed();
      },
      title: (title, id) => {
        if (id) setYtTitle(id, title);
        const d = Math.round(yt.duration());
        const k = cur && cur.yt ? cur.key : null;
        if (k && d > 0 && !(entryOf(k) || {}).secs) app.setSetting("youtubeLibrary", allOnline().map((x) => (keyOfEntry(x) === k ? { ...x, secs: d } : x)));
      },
      error: (msg, code) => {
        const id = cur && cur.yt;
        if (yt.mode === "mini") yt.hide();
        const blocked = code === 101 || code === 150;
        const watch = id ? ytMod.ytWatch(id) : "";
        // a run of them skipped one after another: one note, counting, not a stack
        const again = blocked && ytBlockedToast && Date.now() - ytBlockedAt < 15000;
        ytBlockedN = again ? ytBlockedN + 1 : 1;
        if (again && typeof ytBlockedToast === "function") ytBlockedToast();
        {
          const said = !blocked ? msg : ytBlockedN > 1 ? `${ytBlockedN} videos in a row play only on YouTube - skipped` : "Its owner lets it play only on YouTube" + (queue.items.length > 1 ? " - skipped" : "");
          const t = app.toast(said, { kind: "error", ms: 7000,
            action: id ? { label: blocked ? "Watch on YouTube" : "Open original", run: () => (app.playerOpenHere ? app.playerOpenHere(watch) : app.openUrl(watch)) } : null });
          ytBlockedToast = blocked ? t : null;
        }
        if (blocked) ytBlockedAt = Date.now();
        if ((code === 101 || code === 150 || code === 100) && queue.items.length > 1) setTimeout(() => next({ auto: true }), 1200);
      },
    }, { controls: app.settings.playerYtControls !== false, least: true });
    // the buttons on the tile: in a strip of their own above the picture, never in front of it (styles/media.css)
    document.body.classList.add("yt-by-rules");
    yt.layer.append(h("div", { class: "yt-tile-bar" },
      h("button", { class: "yt-tile-btn", title: "Open the Player", onclick: ytToPlayer }, icon("expand")),
      h("button", { class: "yt-tile-btn", title: "Hide the video and pause it", onclick: () => { ytTileHidden = true; app.setSetting("playerYtTileHidden", true); ytAway(); } }, icon("x"))));
    // a right-click on what is ours around YouTube's frame: the Player's menu, never the webview's own
    yt.layer.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); pillMenu(e.clientX, e.clientY + 8); });
    return yt;
  }
  /** The tile's way to the Player. The tile can be there with the Player open: its place is scrolled away, or the window too small. */
  function ytToPlayer() {
    app.openView("music");
    if (!stage || !stage.isConnected) return;
    stage.scrollIntoView({ block: "center" });
    yt.place();
    if (yt.tile) app.toast("Too little room for the video here: YouTube's player needs 356 x 200 at least, so it stays in the corner.", { ms: 6000 });
  }
  function ytAway() {
    if (!yt) return;
    // closing the tile holds for a place too small as well (styles/media.css), until play is pressed
    document.body.classList.toggle("yt-tile-off", ytTileHidden);
    if (stage && stage.isConnected && stage.offsetParent) { if (ytTileHidden) yt.pause(); return yt.anchor(stage); }
    // hidden when asked: it pauses
    if (ytTileHidden) { yt.hide(); yt.pause(); }
    else yt.mini();
  }

  /** The Player view hands over (or takes back, with null) its video area. */
  function setStage(el) {
    stage = el;
    if (!cur) return;
    if (cur.yt && yt) { if (el) yt.anchor(el); else ytAway(); }
  }

  // the online library (settings key kept from when it held YouTube only):
  // { id, title, addedAt } for YouTube, { url, title, audio, addedAt } for direct links
  const allOnline = () => (Array.isArray(S.youtubeLibrary) ? S.youtubeLibrary : []);
  const ytLib = () => allOnline().filter((x) => x.id);
  const keyOfEntry = (x) => (x.url ? Q.urlKey(x.url) : Q.ytKey(x.id));
  // looked up for every tile and every step of a sort: a map, rebuilt only when the list itself is replaced
  let onIdx = null, onIdxOf = null;
  const entryOf = (key) => {
    const lib = allOnline();
    if (onIdxOf !== lib) { onIdxOf = lib; onIdx = new Map(lib.map((x) => [keyOfEntry(x), x])); }
    return onIdx.get(key);
  };
  function setYtTitle(id, title) {
    const lib = allOnline();
    const it = lib.find((x) => x.id === id);
    if (!it || !title || it.title === title || it.named) return;
    app.setSetting("youtubeLibrary", lib.map((x) => (x.id === id ? { ...x, title } : x)));
    emit("library");
    changed();
  }
  /** Add a YouTube link to the library; resolves to its key (or null for a bad link). */
  async function addYouTube(input) {
    ytMod = ytMod || (await import("./youtube.js"));
    const v = typeof input === "object" && input ? input : ytMod.parseYouTube(input);
    if (!v || !v.id) return null;
    const lib = allOnline();
    if (!lib.some((x) => x.id === v.id)) {
      app.setSetting("youtubeLibrary", [{ id: v.id, title: v.title || "", addedAt: Date.now() }, ...lib]);
      emit("library");
      ytMod.ytTitle(v.id).then((r) => r && setYtTitle(v.id, r.title));
    }
    return Q.ytKey(v.id);
  }
  // titles missing from the list (added offline, or by hand): asked once a session
  const asked = new Set();
  /** One video's facts patched in place (gone or back, when last looked). */
  function patchYt(id, fields) {
    const lib = allOnline();
    if (!lib.some((x) => x.id === id)) return;
    app.setSetting("youtubeLibrary", lib.map((x) => (x.id === id ? { ...x, ...fields } : x)));
    emit("library");
  }
  /** Names for the nameless, and a daily look at whether each video is still up. The name is kept
   *  whatever happens to the video, so a taken-down song can be found again. */
  let filledAt = 0;
  async function fillTitles() {
    const now = Date.now();
    // a round every half minute at most, however often the Player redraws: a big library is looked over in the background
    if (now - filledAt < 30000) return;
    filledAt = now;
    const missing = ytLib().filter((x) => !x.title && !asked.has(x.id)).slice(0, 12);
    // checked again: weekly - and once more each one taken for gone before 7 Oct 2026, when a video that
    // plays only on YouTube was read as removed
    const stale = ytLib().filter((x) => x.title && !asked.has(x.id) && (!x.checkedAt || now - x.checkedAt > 7 * 86400000 || ((x.gone || x.webOnly) && x.checkedAt < GONE_FIX))).slice(0, 8);
    if (!missing.length && !stale.length) return;
    ytMod = ytMod || (await import("./youtube.js"));
    const got = new Map(); // id -> the facts found
    await Promise.all([...missing, ...stale].map((x) => {
      asked.add(x.id);
      return ytMod.ytTitle(x.id).then((r) => {
        if (!r) return;
        const f = { gone: !!r.gone, checkedAt: Date.now() };
        if (r.webOnly) f.webOnly = true; // plays only on YouTube: marked, never taken for gone
        else if (x.webOnly) f.webOnly = false;
        if (r.private) f.private = true;
        // a stored name is kept current (YouTube's developer policies, III.E.4), unless the user gave it
        if (!r.gone && r.title && !x.named) f.title = r.title;
        // gone: since when; its name dropped after 30 days (unless the user gave it)
        const g = ytMod.goneFields(x, !!r.gone, Date.now());
        Object.assign(f, g);
        got.set(x.id, f);
      });
    }));
    if (!got.size) return;
    const lib = allOnline();
    // a redraw only when something shows: a name arrived, or a video went (or came back)
    const shows = lib.some((x) => got.has(x.id) && (!!x.gone !== got.get(x.id).gone || (got.get(x.id).webOnly && !x.webOnly) || (got.get(x.id).title !== undefined && got.get(x.id).title !== x.title)));
    app.setSetting("youtubeLibrary", lib.map((x) => (got.has(x.id) ? { ...x, ...got.get(x.id) } : x)));
    if (shows) { emit("library"); changed(); }
  }
  function removeYouTube(id) {
    app.setSetting("youtubeLibrary", allOnline().filter((x) => x.id !== id));
    emit("library");
  }
  /** Any online link: YouTube or a direct media file. Resolves to its key, or null. */
  async function addOnline(input) {
    if (input && typeof input === "object" && input.id) return addYouTube(input);
    const d = typeof input === "object" && input && input.url ? input : Q.parseDirect(input);
    if (!d) return addYouTube(input);
    const key = Q.urlKey(d.url);
    if (!entryOf(key)) {
      const title = d.title || decodeName(d.name || d.url);
      app.setSetting("youtubeLibrary", [{ url: d.url, title, audio: !!d.audio, addedAt: Date.now() }, ...allOnline()]);
      emit("library");
    }
    return key;
  }
  /** Many YouTube videos at once (a playlist): one settings write, not 200. */
  function addManyOnline(items) {
    const lib = allOnline();
    const have = new Map(lib.filter((x) => x.id).map((x) => [x.id, x]));
    const fresh = [];
    const secsOf = new Map(); // a length the list page gave, for a video already here without one
    // a whole list at once: "Date added" keeps its order - each a millisecond after the one before it
    const now = Date.now();
    items.forEach((it, i) => {
      if (!it || !it.id) return;
      const was = have.get(it.id);
      if (was) { if (it.secs > 0 && !was.secs) secsOf.set(it.id, it.secs); return; }
      const e = { id: it.id, title: it.title || "", addedAt: now - (items.length - 1 - i), ...(it.secs > 0 ? { secs: it.secs } : {}) };
      have.set(it.id, e);
      fresh.push(e);
    });
    if (fresh.length || secsOf.size) {
      app.setSetting("youtubeLibrary", [...fresh, ...(secsOf.size ? lib.map((x) => (secsOf.has(x.id) ? { ...x, secs: secsOf.get(x.id) } : x)) : lib)]);
      emit("library");
    }
    return items.filter((it) => it && it.id).map((it) => Q.ytKey(it.id));
  }

  /** Names found for videos that had none (a Map id -> name), in one write; a name already known stays. */
  function nameOnline(names) {
    let n = 0;
    const lib = allOnline().map((x) => { const t = names.get(x.id); if (!t || x.title) return x; n++; return { ...x, title: t }; });
    if (n) { app.setSetting("youtubeLibrary", lib); emit("library"); }
    return n;
  }
  const decodeName = (n) => n.slice(n.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim() || n;
  /** One key or many (a playlist's worth): one write. They leave the queue too - the one playing plays on. */
  function removeOnline(keys) {
    const drop = new Set([].concat(keys));
    app.setSetting("youtubeLibrary", allOnline().filter((x) => !drop.has(keyOfEntry(x))));
    const at = queue.items.map((k, i) => (drop.has(k) && i !== queue.index ? i : -1)).filter((i) => i >= 0).reverse();
    if (at.length) { for (const i of at) Q.remove(queue, i); queueChanged(); }
    emit("library");
  }

  /* ── kept previews ───────────────────────────────────────────────────── */
  const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAIBAAA=";
  // A YouTube video's picture copied once into <vault>/.leonote/previews and
  // loaded from the disk after that: a thousand tiles don't ask YouTube for a
  // thousand pictures each time, and a video taken down keeps its face. Only
  // tiles that come on screen ask (two at a time); a video played is fetched
  // again, in case its uploader changed the picture.
  // Kept small: each picture made a 192x108 WebP of a few KB (the webview has the codecs), so
  // thousands of them are a few tens of MB and load at once. Nothing runs by itself: the pictures
  // kept before are made small, and any fetched again, only on Rescan libraries.
  const kept = { dir: "", have: null, small: new Set(), asked: new Set(), wait: [], running: 0 };
  const keepPreviews = () => S.playerKeepPreviews !== false && !!app.host.ytPreviews;
  if (keepPreviews()) app.host.ytPreviews().then((r) => {
    kept.dir = r.dir;
    kept.have = new Set(r.ids);
    kept.small = new Set(r.small || []);
    // tiles drawn before the list was read showed no picture: drawn again, from the disk
    emit("library");
  }).catch(() => { kept.have = new Set(); });
  function pumpPreviews() {
    while (kept.running < 2 && kept.wait.length) {
      const [id, refresh] = kept.wait.shift();
      kept.running++;
      app.host.ytPreviewKeep(id, refresh).then((ok) => { if (ok) { kept.have.add(id); if (refresh) kept.small.delete(id); return shrink(id); } }).catch(() => {}).finally(() => { kept.running--; pumpPreviews(); });
    }
  }
  /** A kept picture made small, in its place. Without a WebP encoder it stays as it is. */
  async function shrink(id) {
    if (kept.small.has(id) || !app.host.ytPreviewPut || typeof OffscreenCanvas === "undefined") return;
    const bytes = await app.host.ytPreviewBytes(id);
    const bmp = await createImageBitmap(new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)]), { resizeWidth: 192, resizeHeight: 108, resizeQuality: "high" });
    const c = new OffscreenCanvas(192, 108);
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await c.convertToBlob({ type: "image/webp", quality: 0.74 });
    if (blob.type !== "image/webp") return;
    const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.readAsDataURL(blob); });
    await app.host.ytPreviewPut(id, data);
    kept.small.add(id);
  }
  /** Rescan libraries: every kept picture not small yet made small - asked for, with a count, and stoppable. */
  async function smallPictures(onStep, stop) {
    const todo = kept.have ? [...kept.have].filter((id) => !kept.small.has(id)) : [];
    let done = 0;
    for (const id of todo) {
      if (stop()) break;
      try { await shrink(id); } catch { /* left as it is */ }
      onStep(++done, todo.length);
    }
    if (done) emit("library");
    return done;
  }
  /** Fetched again from YouTube, made small again: the pictures of these keys (a list on screen). */
  function refreshPreviews(keys) {
    const ids = keys.filter(Q.isYt).map(Q.ytIdOf);
    for (const id of ids) { kept.asked.delete(id); keepPreview(id, true); }
    return ids.length;
  }
  function keepPreview(id, refresh = false) {
    if (!keepPreviews() || !kept.have || (!refresh && (kept.have.has(id) || kept.asked.has(id)))) return;
    kept.asked.add(id);
    kept.wait.push([id, refresh]);
    pumpPreviews();
  }
  /** A YouTube video's picture: the kept copy when there is one. `ask`: a tile shows it - keep one if there is none yet. */
  let goneNow = { lib: null, ids: new Set() };
  const isGone = (id) => {
    if (goneNow.lib !== S.youtubeLibrary) goneNow = { lib: S.youtubeLibrary, ids: new Set(ytLib().filter((x) => x.gone).map((x) => x.id)) };
    return goneNow.ids.has(id);
  };
  function ytThumbUrl(id, ask = false) {
    // a video found gone (removed, private) keeps no picture; its kept file goes within the 30 days (ytlist.rs)
    if (isGone(id)) return BLANK;
    // the kept list not read yet: no picture for a moment, rather than YouTube's loading in
    if (kept.have === null && keepPreviews()) return BLANK;
    if (kept.have && kept.have.has(id) && keepPreviews()) return app.host.assetAbs(kept.dir + (kept.dir.includes("\\") ? "\\" : "/") + id + (kept.small.has(id) ? ".webp" : ".jpg"));
    if (ask) keepPreview(id);
    return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  }
  /** An online item now lives in the vault: point the queue and playlists at the file. */
  function replaceKey(from, to) {
    Q.replaceKey(queue, from, to);
    if (cur && cur.key === from) { /* keeps playing the online copy until the next play */ }
    queueChanged();
    const pls = lists();
    if (pls.some((p) => p.items.includes(from))) saveLists(pls.map((p) => (p.items.includes(from) ? { ...p, items: [...new Set(p.items.map((k) => (k === from ? to : k)))] } : p)), true);
  }

  /* ── media libraries outside the vault ───────────────────────────────── */
  // The folders themselves live in settings (so they survive and the Rust
  // side can hand them their asset scope at startup); what is in them is
  // scanned on demand and kept only in memory.
  const libEntries = new Map(); // "lib:D:/Music/a.mp3" -> { path, abs, name, size, mtime, kind }
  const libState = new Map(); // folder -> { scanning, count, error, capped }
  let libReady = null;
  // An outpost is a library too, unless it was told not to be: its songs and
  // videos show up in the Player and go into playlists like any other.
  const dirKey = (d) => String(d || "").split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  const ownLibs = () => (Array.isArray(S.playerLibraries) ? S.playerLibraries : []);
  const outposts = () => (Array.isArray(S.outposts) ? S.outposts.filter((o) => o && o.path) : []);
  const isOutpost = (dir) => outposts().some((o) => dirKey(o.path) === dirKey(dir));
  const libList = () => {
    const own = ownLibs();
    const mine = new Set(own.map((l) => dirKey(l.path)));
    return [...own, ...outposts().filter((o) => o.player !== false && !mine.has(dirKey(o.path))).map((o) => ({ path: o.path, name: o.name || o.path, outpost: true }))];
  };
  const saveLibs = (v) => { app.setSetting("playerLibraries", v.filter((l) => !l.outpost)); emit("libraries"); };

  function takeScan(r) {
    const dir = r.path;
    for (const [k, e] of libEntries) if (e.lib === dir) libEntries.delete(k);
    for (const f of r.files || []) {
      const key = Q.libKey(f.path);
      libEntries.set(key, { path: key, abs: f.path, lib: dir, name: f.name, size: f.size, mtime: f.mtime, kind: f.kind });
    }
    libState.set(dir, { count: r.count ?? (r.files || []).length, capped: !!r.capped });
    emit("libraries");
    return r;
  }
  async function scanLib(dir) {
    libState.set(dir, { ...(libState.get(dir) || {}), scanning: true });
    emit("libraries");
    try {
      return takeScan(await app.host.libraryScan(dir));
    } catch (e) {
      libState.set(dir, { error: String(e && e.message ? e.message : e) });
      emit("libraries");
      return null;
    }
  }
  /** Scan every remembered library once (the Player asks when it opens). */
  function ensureLibs(force) {
    if (libReady && !force) return libReady;
    libReady = Promise.all(libList().map((l) => scanLib(l.path))).then(() => {});
    return libReady;
  }
  async function addLib(dir) {
    if (!dir) return null;
    const r = await app.host.libraryAdd(dir);
    takeScan(r);
    const rest = libList().filter((l) => l.path !== r.path);
    saveLibs([...rest, { path: r.path, name: r.name, count: r.count, addedAt: Date.now() }]);
    return r;
  }
  function forgetEntries(dir) {
    for (const [k, e] of libEntries) if (e.lib === dir) libEntries.delete(k);
    libState.delete(dir);
    const drop = queue.items.map((k, i) => (Q.isLib(k) && !libEntries.has(k) && !outside.has(k) ? i : -1)).filter((i) => i >= 0).reverse();
    if (drop.length) { for (const i of drop) Q.remove(queue, i); queueChanged(); }
    if (cur && Q.isLib(cur.key) && !libEntries.has(cur.key)) stop();
  }
  /**
   * A folder now lies somewhere else (another drive letter, another
   * computer): whatever pointed into it - playlists, the queue, where each
   * file was left off - points at the new place.
   */
  function relocate(from, to) {
    const a = "lib:" + String(from).split("\\").join("/").replace(/\/+$/, "") + "/";
    const b = "lib:" + String(to).split("\\").join("/").replace(/\/+$/, "") + "/";
    if (a.toLowerCase() === b.toLowerCase()) return 0;
    const move = (k) => (typeof k === "string" && k.toLowerCase().startsWith(a.toLowerCase()) ? b + k.slice(a.length) : k);
    let n = 0;
    const pls = lists().map((p) => {
      const items = p.items.map(move);
      const hit = items.filter((k, i) => k !== p.items[i]).length;
      n += hit;
      return hit ? { ...p, items: [...new Set(items)] } : p;
    });
    if (n) saveLists(pls);
    let q = false;
    queue.items.forEach((k) => { const t = move(k); if (t !== k) { Q.replaceKey(queue, k, t); q = true; } });
    for (const k of Object.keys(positions)) { const t = move(k); if (t !== k) { positions[t] = positions[k]; delete positions[k]; } }
    savePositions();
    if (ownLibs().some((l) => dirKey(l.path) === dirKey(from))) app.setSetting("playerLibraries", ownLibs().map((l) => (dirKey(l.path) === dirKey(from) ? { ...l, path: to } : l)));
    forgetEntries(from);
    if (q) queueChanged();
    if (libReady) scanLib(to);
    emit("libraries");
    return n;
  }
  // outposts come and go in the sidebar: the Player follows
  app.bus.on("settings", (k) => {
    if (k !== "outposts") return;
    const now = new Set(libList().map((l) => l.path));
    for (const dir of [...libState.keys()]) if (!now.has(dir)) forgetEntries(dir);
    if (libReady) for (const dir of now) if (!libState.has(dir)) scanLib(dir);
    emit("libraries");
  });
  function removeLib(dir) {
    // an outpost stays hooked up in the sidebar; it just stops playing here
    if (isOutpost(dir) && !ownLibs().some((l) => l.path === dir)) app.setSetting("outposts", outposts().map((o) => (dirKey(o.path) === dirKey(dir) ? { ...o, player: false } : o)));
    saveLibs(libList().filter((l) => l.path !== dir));
    for (const [k, e] of libEntries) if (e.lib === dir) libEntries.delete(k);
    libState.delete(dir);
    // whatever was queued from it cannot play any more
    const drop = queue.items.map((k, i) => (Q.isLib(k) && !libEntries.has(k) && !outside.has(k) ? i : -1)).filter((i) => i >= 0).reverse();
    if (drop.length) { for (const i of drop) Q.remove(queue, i); queueChanged(); }
    if (cur && Q.isLib(cur.key) && !libEntries.has(cur.key)) stop();
  }
  const libraries = {
    list: libList, files: () => libEntries, entry: (k) => libEntries.get(k),
    state: (dir) => libState.get(dir) || {}, ensure: ensureLibs, rescan: scanLib,
    add: addLib, remove: removeLib, relocate,
    rename: (dir, name) => saveLibs(libList().map((l) => (l.path === dir ? { ...l, name } : l))),
  };

  /* ── playing ─────────────────────────────────────────────────────────── */
  // A file outside the vault is known by where it lies on the disk, so it can
  // always be TRIED: the lists kept in memory (a scanned library, the folder a
  // tab was opened from) may simply not hold it right now - not scanned yet
  // this session, scanned again, another folder opened since. Calling such a
  // song "not there any more" emptied a queue that was perfectly playable; a
  // file that really is gone fails to load and is skipped then.
  const SEP = String.fromCharCode(92);
  const diskPath = (key) => Q.libPath(key).split("/").join(SEP);
  const exists = (key) => (Q.isOnline(key) ? true : Q.isLib(key) ? true : app.vault.files.has(key));

  async function playKey(key, { autoplay = true } = {}) {
    if (!key) return;
    if (!exists(key)) {
      app.toast(`${key.slice(key.lastIndexOf("/") + 1)} is not there any more`, { kind: "error", ms: 2500 });
      return;
    }
    // a library song nobody has listed yet this session: the libraries are read
    // first, which is also what lets the webview load files from them
    if (Q.isLib(key) && !libEntries.has(key) && !outside.has(key)) { try { await ensureLibs(); } catch {} }
    started = true;
    clearTimeout(sleepTimerEnd);
    if (Q.isYt(key)) {
      const id = Q.ytIdOf(key);
      for (const q of players.values()) if (!q.el.paused) q.el.pause();
      const before = cur && cur.p;
      cur = { key, yt: id };
      letGo(before);
      // its picture kept if it is not yet (fetched again only when asked: Rescan libraries, or the list's …)
      keepPreview(id);
      changed();
      try {
        const p = await ytPlayer();
        if (!cur || cur.key !== key) return;
        if (stage && stage.isConnected && stage.offsetParent) p.anchor(stage);
        else ytAway();
        await p.load(id, { start: positions[key] || 0, play: autoplay });
        applyLevels();
      } catch (e) {
        app.toast(String(e.message || e), { kind: "error", ms: 7000, action: { label: "Open original", run: () => (app.playerOpenHere ? app.playerOpenHere(`https://www.youtube.com/watch?v=${id}`) : app.openUrl(`https://www.youtube.com/watch?v=${id}`)) } });
      }
      return;
    }
    leaveYt();
    const p = player(key);
    p.owned = true;
    stopOthers(key);
    const before = cur && cur.p;
    cur = { key, p };
    if (before !== p) letGo(before);
    applyLevels();
    graphJoin();
    if (!p.el.isConnected) dock.append(p.el);
    // failed before (the drive was out, the file away): an element in its error state never tries again by itself
    if (p.el.error) p.el.src = srcUrl(app, p.path || copy || key);
    if (autoplay) {
      if (p.el.ended) p.el.currentTime = 0;
      if (audioGraph) audioGraph.resume();
      p.el.play().catch((e) => { if (e.name !== "AbortError" && !(p.failSaid && Date.now() - p.failSaid < 3000) && !p.el.error) app.toast("Could not play: " + e.message, { kind: "error" }); });
    }
    changed();
  }

  function playAt(i, opts) {
    const back = opts && opts.back;
    const key = Q.go(queue, i, { back });
    queueChanged();
    return playKey(key, opts);
  }
  /** Replace the queue and play from `start`; `from` names where it came from (a playlist, an album), for the queue's title. */
  function playList(keys, start = 0, from = null) {
    anchorKey = null;
    Q.setItems(queue, keys, start);
    queue.from = from || null;
    queueChanged();
    return playKey(Q.current(queue));
  }
  /** The queue swapped for another list holding the song that plays, which keeps playing. */
  function requeue(keys, at, from = null) {
    Q.setItems(queue, keys, at);
    queue.from = from;
    queueChanged();
  }
  function enqueue(keys, opts) {
    const i = Q.insert(queue, keys, opts);
    queueChanged();
    return i;
  }
  function next({ auto = false } = {}) {
    const i = Q.nextIndex(queue, { auto });
    if (i < 0) { changed(); return; }
    if (i === queue.index && cur) return restart();
    playAt(i);
  }
  function prev() {
    if (time() > 3) return seek(0);
    const i = Q.prevIndex(queue);
    if (i >= 0) playAt(i, { back: queue.shuffle && queue.history.length > 0 });
  }
  function restart() {
    seek(0);
    play();
  }

  const isPlaying = () => (cur ? (cur.yt ? ytPlaying : !cur.p.el.paused) : false);
  function play() {
    if (!cur && resumeLeft()) return;
    if (!cur) return playKey(Q.current(queue));
    if (cur.yt) { if (yt && yt.loaded) yt.play(); else playKey(cur.key); return; }
    if (audioGraph) audioGraph.resume();
    cur.p.el.play().catch(() => {});
  }
  // Pause means silence: EVERYTHING that sounds stops, not only what the pill
  // believes is on. A file left playing behind the current one (a tab's own
  // player that was never told to stop) used to make Pause look broken - the
  // press paused one, the next press started it again over the other.
  const strays = () => [...players.values()].filter((q) => !q.el.paused && !(cur && cur.p === q));
  function pause() {
    for (const q of strays()) q.el.pause();
    if (!cur) return;
    if (cur.yt) { if (yt) yt.pause(); } else cur.p.el.pause();
  }
  const toggle = () => (isPlaying() || strays().length ? pause() : play());
  function time() { return !cur ? 0 : cur.yt ? (yt ? yt.time() : 0) : cur.p.el.currentTime || 0; }
  function duration() {
    if (!cur) return 0;
    if (cur.yt) return yt ? yt.duration() : 0;
    const d = cur.p.el.duration;
    return Number.isFinite(d) ? d : 0;
  }
  function seek(s) {
    if (!cur) return;
    s = Math.max(0, Math.min(s, duration() || s));
    if (cur.yt) { if (yt) yt.seek(s); } else cur.p.el.currentTime = s;
    tick(true);
  }
  function stop() {
    if (!cur && left) { left = null; try { localStorage.removeItem(LAST_KEY); } catch {} paintPill(); return; }
    if (!cur) return;
    if (cur.yt) { if (yt) yt.stop(); ytPlaying = false; clearInterval(ytTimer); }
    else if (players.has(cur.key)) { const p = cur.p; p.el.pause(); if (!(p.home && p.home.isConnected)) dispose(cur.key); }
    cur = null;
    started = false;
    left = null; // stopped on purpose: nothing waits for the next session
    changed();
  }

  let keepPitch = true; // a tempo change leaves the pitch where it is (the Sound panel can join them, like a record)
  function applyLevels() {
    if (!cur) return;
    if (cur.yt) { if (yt && yt.loaded) { yt.setVolume(volume, muted); yt.setRate(rate); } return; }
    const el = cur.p.el;
    el.volume = volume;
    el.muted = muted;
    el.preservesPitch = keepPitch;
    if (cur.p.owned) el.playbackRate = rate;
  }
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (volume > 0 && muted) muted = false;
    applyLevels();
    savePref("playerVolume", Math.round(volume * 100) / 100);
    if (S.playerMuted !== muted) app.setSetting("playerMuted", muted);
    emit("levels");
  }
  function toggleMute() { muted = !muted; applyLevels(); app.setSetting("playerMuted", muted); emit("levels"); }
  function setRate(r, p) {
    rate = r;
    if (p) p.el.playbackRate = r;
    applyLevels();
    savePref("playerRate", r);
    emit("levels");
  }
  /** Speed: the usual steps one click away, and a slider for anything between (0.01 steps). */
  function speedPop(anchor, { get, set }) {
    const old = document.querySelector(".speed-pop");
    if (old) { old.remove(); if (old._for === anchor) return; }
    const val = h("span", { class: "speed-pop-val" });
    const range = h("input", { type: "range", class: "slider", min: 0.25, max: 4, step: 0.01, "aria-label": "Playback speed" });
    const chips = h("div", { class: "speed-pop-chips" }, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((s) => h("button", { class: "speed-pop-chip", dataset: { s }, onclick: () => apply(s) }, s + "×")));
    const paint = () => {
      const r = Math.round(get() * 100) / 100;
      val.textContent = r.toFixed(2) + "×";
      range.value = r;
      for (const c of chips.children) c.classList.toggle("is-on", +c.dataset.s === r);
    };
    const apply = (r) => { set(Math.max(0.25, Math.min(4, Math.round(r * 100) / 100))); paint(); };
    range.addEventListener("input", () => apply(+range.value));
    // the wheel over the slider: a hundredth at a time
    range.addEventListener("wheel", (e) => { e.preventDefault(); apply(get() + (e.deltaY < 0 ? 0.01 : -0.01)); }, { passive: false });
    const pop = h("div", { class: "speed-pop" },
      h("div", { class: "speed-pop-head" }, h("span", { text: "Speed" }), val, h("button", { class: "link-btn", onclick: () => apply(1) }, "Reset")),
      chips,
      h("div", { class: "speed-pop-fine" }, h("button", { class: "speed-pop-step", title: "0.01 slower", onclick: () => apply(get() - 0.01) }, "−"), range, h("button", { class: "speed-pop-step", title: "0.01 faster", onclick: () => apply(get() + 0.01) }, "+")));
    pop._for = anchor;
    document.body.append(pop);
    paint();
    const at = anchor.getBoundingClientRect();
    const box = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(at.left + at.width / 2 - box.width / 2, innerWidth - box.width - 8)) + "px";
    pop.style.top = (at.top - box.height - 8 < 8 ? at.bottom + 8 : at.top - box.height - 8) + "px";
    const close = () => { pop.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); };
    const away = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    setTimeout(() => { document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", esc, true); });
  }

  function setShuffle(on) { queue.shuffle = on; queue.history = []; queueChanged(); changed(); }
  function cycleRepeat() { queue.repeat = { off: "all", all: "one", one: "off" }[queue.repeat]; queueChanged(); changed(); }

  /* ── sleep timer ─────────────────────────────────────────────────────── */
  let sleepAt = 0;
  let sleepEnd = false;
  let sleepTimerEnd = 0;
  let sleepTimer = 0;
  function setSleep(v) {
    clearTimeout(sleepTimer);
    sleepAt = 0;
    sleepEnd = v === "track";
    if (typeof v === "number" && v > 0) {
      sleepAt = Date.now() + v * 60000;
      sleepTimer = setTimeout(() => { sleepAt = 0; pause(); emit("sleep"); changed(); }, v * 60000);
    }
    changed();
  }
  bus.addEventListener("sleep", () => { pause(); app.toast("Sleep timer: paused", { ms: 3000 }); });

  /* ── Web Audio: equalizer and visualizer, only once asked for ────────── */
  let audioGraph = null;
  let graphWanted = false;
  async function graph() {
    if (!audioGraph) {
      const { createAudioGraph } = await import("./audiograph.js");
      audioGraph = audioGraph || createAudioGraph();
      const eq = S.playerEq;
      if (eq && eq.on && Array.isArray(eq.gains)) audioGraph.setGains(eq.gains);
    }
    graphWanted = true;
    graphJoin();
    // awake only for a song that plays through it (a setting changed while paused leaves it asleep)
    if (isPlaying() && cur && !cur.yt) audioGraph.resume();
    return audioGraph;
  }
  function graphJoin() {
    if (!graphWanted || !audioGraph || !cur || cur.yt || cur.p.remote) return;
    audioGraph.attach(cur.p.el);
    audioGraph.resume();
  }
  // a saved equalizer comes back with the first song (after a click, so the context may run)
  if (S.playerEq && S.playerEq.on) bus.addEventListener("change", function once() {
    if (!isPlaying() || cur.yt) return;
    bus.removeEventListener("change", once);
    graph();
  });

  /* ── metadata for any queue key ──────────────────────────────────────── */
  function metaOf(key) {
    if (!key) return null;
    if (Q.isYt(key)) {
      const id = Q.ytIdOf(key);
      const it = entryOf(key);
      const live = cur && cur.key === key && yt ? yt.title() : "";
      return { title: (it && it.title) || live || (it && it.gone ? "Removed video" : "Online video " + id), artist: "Online", cover: ytThumbUrl(id), yt: true, online: true };
    }
    if (Q.isUrl(key)) {
      const it = entryOf(key);
      const d = Q.parseDirect(Q.urlOf(key)) || {};
      let host = "";
      try { host = new URL(Q.urlOf(key)).hostname.replace(/^www\./, ""); } catch {}
      return { title: (it && it.title) || decodeName(d.name || key), artist: host || "Online", cover: "", online: true, audio: !!d.audio };
    }
    const f = Q.isLib(key) ? libEntries.get(key) || outsideEntry(key) : app.vault.files.get(key);
    const m = (f && peekMeta(f)) || guessMeta(Q.isLib(key) ? Q.libPath(key) : key);
    if (!m.cover) {
      const fc = folderCover(app, key);
      if (fc) return { ...m, cover: coverUrl(app, fc) };
    }
    return m;
  }
  const metaAsked = new Set();
  /** a file outside the vault that no library lists, as an entry of its own */
  function outsideEntry(key) {
    const abs = outside.get(key);
    return abs ? { path: key, abs, lib: "", name: abs.slice(Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\")) + 1), size: 0, mtime: 0, kind: "media" } : null;
  }
  function metaReady(key) {
    const f = !Q.isOnline(key) && (Q.isLib(key) ? libEntries.get(key) || outsideEntry(key) : app.vault.files.get(key));
    return f ? loadMeta(app, f) : Promise.resolve(metaOf(key));
  }

  /* ── time ticks (throttled to paint rate) ────────────────────────────── */
  let tickRaf = 0;
  function tick(now) {
    if (now === true) { emit("time"); paintPill(); return; }
    if (tickRaf) return;
    tickRaf = requestAnimationFrame(() => { tickRaf = 0; emit("time"); paintPill(); positionState(); });
  }

  /* ── Media Session: Windows media keys and the OS overlay ────────────── */
  const ms = navigator.mediaSession;
  let msKey = null;
  if (ms) {
    const on = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
    on("play", () => play());
    on("pause", () => pause());
    on("stop", () => stop());
    on("previoustrack", () => prev());
    on("nexttrack", () => next());
    on("seekbackward", (d) => seek(time() - (d.seekOffset || 10)));
    on("seekforward", (d) => seek(time() + (d.seekOffset || 10)));
    on("seekto", (d) => seek(d.seekTime));
  }
  let lastPos = 0;
  function positionState() {
    if (!ms || !ms.setPositionState || !cur) return;
    const now = Date.now();
    if (now - lastPos < 1000) return;
    lastPos = now;
    const d = duration();
    try { if (d > 0) ms.setPositionState({ duration: d, position: Math.min(time(), d), playbackRate: rate }); } catch {}
  }
  function paintSession() {
    if (!ms) return;
    ms.playbackState = !cur ? "none" : isPlaying() ? "playing" : "paused";
    if (!cur || msKey === cur.key + "|" + (metaOf(cur.key) || {}).title) return;
    const m = metaOf(cur.key);
    msKey = cur.key + "|" + m.title;
    try {
      ms.metadata = new MediaMetadata({ title: m.title, artist: m.artist || "", album: m.album || "", artwork: m.cover ? [{ src: m.cover, sizes: "320x320" }] : [] });
    } catch {}
    // only a vault file can still be waiting for its tags (an online item
    // never is, and asking again here would loop)
    // asked once per key: a file whose tags cannot be read stays a guess, and
    // asking again and again would spin for ever
    if (m.guess && !Q.isOnline(cur.key) && !metaAsked.has(cur.key)) { metaAsked.add(cur.key); metaReady(cur.key).then(() => { msKey = null; paintSession(); paintPill(true); }); }
  }

  /* ── the now-playing pill (placed by main.js in the status bar) ─────── */
  const pillArt = h("span", { class: "mp-pill-art" });
  const pillName = h("span", { class: "mp-pill-name" });
  const pillTime = h("span", { class: "mp-pill-time" });
  const pbtn = (ic, title, run) => h("button", { class: "mp-pill-btn", title, onclick: (e) => { e.stopPropagation(); run(); } }, icon(ic));
  const pillPlay = pbtn("play", "Play / pause", toggle);
  const pill = h("div", { class: "mp-pill", hidden: true, title: "Now playing · click to open the Player · right-click for more", onclick: () => app.openView("music"),
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); pillMenu(e.clientX, e.clientY); } },
    pillArt, pbtn("back", "Previous", prev), pillPlay, pbtn("forward", "Next", next), pillName, pillTime,
    pbtn("x", "Stop", stop));
  // Previous, play, next in one row; under it six jumps. A jump that is held
  // keeps going and gathers pace, so a long hold crosses a long file.
  function transportRows() {
    const playB = h("button", { class: "mp-tr-btn is-main", title: "Play / pause" }, icon(isPlaying() ? "pauseSolid" : "playSolid"));
    playB.addEventListener("click", () => { toggle(); setTimeout(() => playB.replaceChildren(icon(isPlaying() ? "pauseSolid" : "playSolid")), 120); });
    const jump = (by) => {
      const b = h("button", { class: "mp-tr-jump", title: `${by < 0 ? "Back" : "Forward"} ${Math.abs(by)} seconds - hold to keep going`, text: (by < 0 ? "−" : "+") + Math.abs(by) });
      let t = 0;
      let n = 0;
      const go = () => { n++; seek(Math.max(0, time() + by * (n > 14 ? 4 : n > 6 ? 2 : 1))); };
      const stopIt = () => { clearInterval(t); t = 0; n = 0; };
      b.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; e.preventDefault(); b.setPointerCapture(e.pointerId); go(); t = setInterval(go, 240); });
      for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(ev, stopIt);
      return b;
    };
    // where it is, and a track to take it anywhere: click or drag
    const fill = h("div", { class: "mp-tr-fill" });
    const knob = h("div", { class: "mp-tr-knob" });
    const track = h("div", { class: "mp-tr-track", title: "Click or drag to seek" }, fill, knob);
    const now = h("span", { class: "mp-tr-time" });
    const total = h("span", { class: "mp-tr-time" });
    let dragging = false;
    const paintTime = (at = time()) => {
      const d = duration() || 0;
      const f = d ? Math.max(0, Math.min(1, at / d)) : 0;
      fill.style.width = f * 100 + "%";
      knob.style.left = f * 100 + "%";
      now.textContent = fmtTime(at);
      total.textContent = d ? fmtTime(d) : "–:––";
    };
    const atPointer = (e) => { const r = track.getBoundingClientRect(); return (duration() || 0) * Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !duration()) return;
      e.preventDefault();
      dragging = true;
      track.setPointerCapture(e.pointerId);
      paintTime(atPointer(e));
    });
    track.addEventListener("pointermove", (e) => { if (dragging) paintTime(atPointer(e)); });
    for (const ev of ["pointerup", "pointercancel"]) track.addEventListener(ev, (e) => { if (!dragging) return; dragging = false; if (ev === "pointerup") seek(atPointer(e)); });
    const timer = setInterval(() => { if (!track.isConnected) return clearInterval(timer); if (!dragging) paintTime(); }, 400);
    requestAnimationFrame(() => paintTime());
    // shuffle and repeat flank the transport
    const mixB = h("button", { class: "mp-tr-btn is-side", onclick: () => { setShuffle(!queue.shuffle); paintSides(); } }, icon("shuffle"));
    const repB = h("button", { class: "mp-tr-btn is-side", onclick: () => { cycleRepeat(); paintSides(); } });
    const paintSides = () => {
      mixB.classList.toggle("is-on", !!queue.shuffle);
      mixB.title = queue.shuffle ? "Shuffle is on" : "Shuffle";
      repB.classList.toggle("is-on", queue.repeat !== "off");
      repB.replaceChildren(icon(queue.repeat === "one" ? "repeatOne" : "repeat"));
      repB.title = queue.repeat === "one" ? "Repeating this one - press for no repeat" : queue.repeat === "all" ? "Repeating the queue - press to repeat only this one" : "No repeat - press to repeat the queue";
    };
    paintSides();
    // loudness and speed: two quiet sliders
    const slider = (ic, min, max, step, get, set, fmt, title, reset) => {
      const val = h("span", { class: "mp-tr-val" });
      const input = h("input", { type: "range", class: "mp-tr-range", min, max, step, title });
      const paintIt = () => { const v = get(); input.value = String(v); input.style.setProperty("--f", ((v - min) / (max - min)) * 100 + "%"); val.textContent = fmt(v); };
      input.addEventListener("input", () => { set(Number(input.value)); paintIt(); });
      input.addEventListener("keydown", (e) => e.stopPropagation());
      // the menu swallows presses so its rows never take the focus - a slider needs its own
      for (const ev of ["mousedown", "pointerdown", "touchstart"]) input.addEventListener(ev, (e) => e.stopPropagation());
      const b = h("button", { class: "mp-tr-ico", title: reset.title, onclick: () => { reset.run(); paintIt(); } }, icon(ic));
      paintIt();
      return h("div", { class: "mp-tr-line" }, b, input, val);
    };
    const curRate = () => (cur && cur.p ? cur.p.el.playbackRate : rate) || 1;
    const loud = slider("volume", 0, 1, 0.01, () => (muted ? 0 : volume), (v) => { if (muted && v > 0) toggleMute(); setVolume(v); }, (v) => Math.round(v * 100) + "%", "Loudness", { title: "Mute / unmute", run: () => toggleMute() });
    const fast = slider("clock", 0.25, 3, 0.05, curRate, (v) => setRate(v, cur && cur.p), (v) => (Math.round(v * 100) / 100) + "×", "Speed", { title: "Back to 1×", run: () => setRate(1, cur && cur.p) });
    return h("div", { class: "mp-tr" },
      h("div", { class: "mp-tr-line" }, now, track, total),
      h("div", { class: "mp-tr-row" },
        mixB,
        h("button", { class: "mp-tr-btn", title: "Previous", onclick: () => prev() }, icon("skipPrev")), playB,
        h("button", { class: "mp-tr-btn", title: "Next", onclick: () => next() }, icon("skipNext")),
        repB),
      h("div", { class: "mp-tr-row is-jumps" }, [-60, -30, -5, 5, 30, 60].map(jump)),
      loud, cur && cur.yt ? null : fast);
  }
  function pillMenu(x, y) {
    if (!cur) return;
    const video = cur.p && !cur.p.audio ? cur.p.el : null;
    const onTop = !!window.documentPictureInPicture;
    app.menu(x, y - 8, [
      { header: metaOf(cur.key).title || "Now playing" },
      // to cite the exact moment of a video (a link written down, nothing fetched)
      cur.yt ? { label: "Copy link at this moment", icon: "link", run: () => navigator.clipboard.writeText(`https://youtu.be/${cur.yt}?t=${Math.floor(time())}`).then(() => app.toast("Link copied", { ms: 1400 })) } : null,
      // a video file goes into a window of its own, on top of everything -
      // the Player stays shut
      video && document.pictureInPictureEnabled
        ? { label: document.pictureInPictureElement === video ? "Leave picture in picture" : "Picture in picture", icon: "pip", run: () => togglePip(video) } : null,
      // (the video on the Player's stage: there is no tile to speak of)
      cur.yt && (!yt || yt.mode !== "anchored" || yt.tile)
        ? { label: yt && yt.tile && !ytTileHidden ? "Hide the video tile and pause" : "Show the video in the corner", icon: "pip",
            run: () => { if (yt && yt.tile && !ytTileHidden) { ytTileHidden = true; app.setSetting("playerYtTileHidden", true); } else { ytTileHidden = false; app.setSetting("playerYtTileHidden", false); } ytAway(); } } : null,
      // (no mini player over a YouTube video, which would play on unseen behind other windows)
      (app.host.real || onTop) && !cur.yt ? { label: miniWin || miniOpen ? "Close the mini player" : "Mini player on top of other windows", icon: "pip", run: () => miniPlayer() } : null,
      "sep",
      { el: transportRows() },
      "sep",
      { label: "Open the Player", icon: "music", run: () => app.openView("music") },
      { label: "Stop", icon: "x", run: stop },
    ].filter(Boolean));
  }

  /* A song has no picture to put in picture-in-picture, so it gets a small
     always-on-top window of its own instead (where the webview offers one):
     the cover, the name, and the three buttons. */
  let miniWin = null;
  /* In the app the mini player is a small window of its own (mini.html),
     always on top: it is told what plays, and sends back its buttons. */
  let miniOpen = false;
  let miniSent = 0;
  // Art that lives in a blob (a song's embedded picture) cannot cross to
  // another window, so it goes over as a small data URL, made once per picture.
  const miniArt = { src: "", data: "" };
  function miniCover(src) {
    if (!src) return "";
    if (!/^blob:/.test(src)) return src;
    if (miniArt.src === src) return miniArt.data;
    miniArt.src = src;
    miniArt.data = "";
    const img = new Image();
    img.onload = () => {
      if (miniArt.src !== src) return;
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 192;
        const k = Math.max(192 / img.naturalWidth, 192 / img.naturalHeight);
        const w = img.naturalWidth * k;
        const hh = img.naturalHeight * k;
        c.getContext("2d").drawImage(img, (192 - w) / 2, (192 - hh) / 2, w, hh);
        miniArt.data = c.toDataURL("image/jpeg", 0.86);
        miniState(true);
      } catch {}
    };
    img.src = src;
    return "";
  }
  // a playing video file is shown in the mini player's square: small frames, a few a second
  let miniFrameT = 0;
  const miniCanvas = document.createElement("canvas");
  miniCanvas.width = miniCanvas.height = 160;
  function miniVideoEl() {
    const el = cur && !cur.yt && cur.p ? cur.p.el : null;
    return el && el.tagName === "VIDEO" && el.videoWidth ? el : null;
  }
  function miniFrame() {
    const el = miniOpen ? miniVideoEl() : null;
    if (!el) return;
    try {
      const k = Math.max(160 / el.videoWidth, 160 / el.videoHeight);
      const w = el.videoWidth * k;
      const hh = el.videoHeight * k;
      miniCanvas.getContext("2d").drawImage(el, (160 - w) / 2, (160 - hh) / 2, w, hh);
      app.host.emitTo("mini", "mini:frame", { src: miniCanvas.toDataURL("image/jpeg", 0.7) }).catch(() => {});
    } catch {}
  }
  function miniFrames() {
    // frames only while the video plays (play and pause come through miniState); a paused one keeps its last frame
    const want = miniOpen && !!miniVideoEl() && isPlaying();
    if (want && !miniFrameT) { miniFrame(); miniFrameT = setInterval(() => { if (!miniOpen || !miniVideoEl() || !isPlaying()) miniFrames(); else miniFrame(); }, 125); }
    else if (!want && miniFrameT) { clearInterval(miniFrameT); miniFrameT = 0; if (miniOpen && miniVideoEl()) miniFrame(); }
  }
  function miniState(force) {
    miniFrames();
    if (!miniOpen) return;
    const now = performance.now();
    if (!force && now - miniSent < 450) return;
    miniSent = now;
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const m = cur ? metaOf(cur.key) : null;
    app.host.emitTo("mini", "mini:state", {
      title: m ? (m.artist && !m.yt ? `${m.title} · ${m.artist}` : m.title) : "",
      cover: m ? miniCover(m.cover || "") : "",
      video: !!miniVideoEl(),
      gradient: m ? Q.gradientFor(m.album || m.title) : "",
      time: time(), duration: duration(), playing: isPlaying(),
      bg: v("--bg-2"), fg: v("--text"), dim: v("--text-3"), accent: v("--accent"),
    }).catch(() => {});
  }
  if (app.host.real) {
    app.host.on("mini:cmd", (p) => {
      const c = p && p.cmd;
      if (c === "hello") { miniOpen = true; miniState(true); }
      else if (c === "closed") miniOpen = false;
      else if (c === "toggle") toggle();
      else if (c === "next") next();
      else if (c === "prev") prev();
      else if (c === "seek" && Number.isFinite(Number(p.at))) seek(Math.max(0, Number(p.at)));
      else if (c === "open") { app.host.win.show(); app.openView("music"); }
    });
    bus.addEventListener("change", () => miniState(true));
    bus.addEventListener("time", () => miniState(false));
  }
  // the queue reaching a YouTube video closes the mini player and brings the main window forward
  bus.addEventListener("change", () => {
    if (!cur || !cur.yt || !(miniOpen || miniWin)) return;
    miniPlayer();
    if (app.host.win) app.host.win.show();
  });
  async function miniPlayer() {
    if (app.host.real) {
      try {
        miniOpen = await app.host.miniPlayer(!miniOpen);
        if (miniOpen) setTimeout(() => miniState(true), 400);
      } catch (err) { app.toast("The mini player could not open: " + (err && err.message ? err.message : err), { kind: "error" }); }
      return;
    }
    const dp = window.documentPictureInPicture;
    if (!dp) return;
    if (miniWin) { miniWin.close(); return; }
    let w;
    try { w = await dp.requestWindow({ width: 340, height: 96 }); } catch (err) { return app.toast("The mini player could not open: " + (err && err.message ? err.message : err), { kind: "error" }); }
    miniWin = w;
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    const d = w.document;
    d.head.append(h("style", { text: `
      html, body { margin: 0; height: 100%; }
      body { display: flex; align-items: center; gap: 12px; padding: 0 14px; box-sizing: border-box; background: ${v("--bg-2", "#15161a")}; color: ${v("--text", "#eee")}; font: 13px/1.35 ${v("--font", "Inter, system-ui, sans-serif")}; overflow: hidden; user-select: none; }
      .art { flex: none; width: 56px; height: 56px; border-radius: 10px; background-size: cover; background-position: center; }
      .meta { flex: 1; min-width: 0; }
      .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .time { color: ${v("--text-3", "#999")}; font-size: 11.5px; font-variant-numeric: tabular-nums; margin-top: 2px; }
      .btns { display: flex; gap: 2px; }
      button { all: unset; width: 32px; height: 32px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: inherit; }
      button:hover { background: rgba(128,128,128,.2); }
      button.play { background: ${v("--text", "#eee")}; color: ${v("--bg-2", "#15161a")}; border-radius: 50%; }
      svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    ` }));
    const art = h("div", { class: "art" });
    const name = h("div", { class: "name" });
    const tm = h("div", { class: "time" });
    const playB = h("button", { class: "play", title: "Play / pause", onclick: toggle });
    d.body.append(art, h("div", { class: "meta" }, name, tm),
      h("div", { class: "btns" }, h("button", { title: "Previous", onclick: () => prev() }, icon("back")), playB, h("button", { title: "Next", onclick: () => next() }, icon("forward"))));
    const paint = () => {
      if (!cur) return w.close();
      const m = metaOf(cur.key);
      name.textContent = m.artist && !m.yt ? `${m.title} · ${m.artist}` : m.title;
      art.style.backgroundImage = m.cover ? `url("${m.cover}")` : Q.gradientFor(m.album || m.title);
      const dur = duration();
      tm.textContent = fmtTime(time()) + (dur ? ` / ${fmtTime(dur)}` : "");
      playB.replaceChildren(icon(isPlaying() ? "pause" : "play"));
    };
    bus.addEventListener("change", paint);
    bus.addEventListener("time", paint);
    w.addEventListener("pagehide", () => { miniWin = null; bus.removeEventListener("change", paint); bus.removeEventListener("time", paint); });
    paint();
  }

  /* What was playing when Leonote closed waits in the pill, paused, where it
     stopped: one press carries on. Nothing loads or plays until then. */
  const LAST_KEY = "leonote.lastPlaying";
  let left = null; // { key, t } from the last session, until something plays
  try { const l = JSON.parse(localStorage.getItem(LAST_KEY) || "null"); if (l && l.key && Q.current(queue) === l.key) left = l; } catch {}
  let lastSaved = 0;
  function rememberPlaying() {
    if (!cur) { if (!left) { try { localStorage.removeItem(LAST_KEY); } catch {} } return; }
    left = null;
    const now = Date.now();
    if (now - lastSaved < 3000 && isPlaying()) return;
    lastSaved = now;
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ key: cur.key, t: Math.round(time()) })); } catch {}
  }
  function resumeLeft() {
    if (!left) return false;
    const { key, t } = left;
    left = null;
    if (t > 5) { positions[key] = t; carried.add(key); }
    playKey(key);
    return true;
  }

  let pillKey = "";
  function paintPill(force) {
    if (!cur && left) {
      pill.hidden = !exists(left.key);
      if (pill.hidden) return;
      pill.classList.add("is-left");
      if (pillKey !== left.key) {
        pillKey = left.key;
        const m = metaOf(left.key);
        pillName.textContent = m.artist && !m.yt ? `${m.title} · ${m.artist}` : m.title;
        pillArt.style.backgroundImage = m.cover ? `url("${m.cover}")` : Q.gradientFor(m.album || m.title);
      }
      pillTime.textContent = left.t > 5 ? `left at ${fmtTime(left.t)}` : "";
      pillPlay.replaceChildren(icon("play"));
      return;
    }
    pill.classList.remove("is-left");
    // The pill stays put while something is loaded - also when the file's own
    // tab is up: it used to step aside there, and a pill that comes and goes
    // as you click through songs reads as "the player lost it". The Player view keeps it too.
    pill.hidden = !cur || !started;
    if (pill.hidden) return;
    if (force || pillKey !== cur.key) {
      pillKey = cur.key;
      const m = metaOf(cur.key);
      pillName.textContent = m.artist && !m.yt ? `${m.title} · ${m.artist}` : m.title;
      pillArt.style.backgroundImage = m.cover ? `url("${m.cover}")` : Q.gradientFor(m.album || m.title);
    }
    const d = duration();
    pillTime.textContent = fmtTime(time()) + (d ? ` / ${fmtTime(d)}` : "");
    pillPlay.replaceChildren(icon(isPlaying() ? "pause" : "play"));
  }
  bus.addEventListener("change", () => { rememberPlaying(); paintPill(); paintSession(); });
  bus.addEventListener("time", rememberPlaying);
  window.addEventListener("beforeunload", () => { lastSaved = 0; if (cur) rememberPlaying(); savePositions.flush(); });
  // library files and titles arrive after boot: the waiting pill paints then
  bus.addEventListener("libraries", () => { if (left) { pillKey = ""; paintPill(); } });
  setTimeout(() => paintPill(), 0);
  // the tab strip only cares about starts and stops
  let lastState = "";
  bus.addEventListener("change", () => {
    const s = (cur && cur.key) + isPlaying();
    if (s !== lastState) { lastState = s; bus.dispatchEvent(new Event("state")); }
  });
  // paused a moment: the sound engine sleeps (every way to play wakes it again first)
  let sleepT = 0;
  bus.addEventListener("state", () => {
    clearTimeout(sleepT);
    if (!audioGraph) return;
    // a YouTube video plays outside it: the same as a pause
    if (isPlaying() && cur && !cur.yt) audioGraph.resume();
    else sleepT = setTimeout(() => { if (!isPlaying() || (cur && cur.yt)) audioGraph.suspend(); }, 2000);
  });

  // files renamed or removed in the vault
  const renamed = ({ from, to }) => {
    const moved = (k) => (k === from ? to : k.startsWith(from + "/") ? to + k.slice(from.length) : k);
    const pls = lists();
    if (pls.some((p) => p.items.some((k) => moved(k) !== k))) saveLists(pls.map((p) => ({ ...p, items: p.items.map(moved) })));
    if (!queue.items.some((k) => k === from || k.startsWith(from + "/"))) return;
    Q.rename(queue, from, to);
    if (cur && cur.key === from) cur.key = to;
    const p = players.get(from);
    if (p) { players.delete(from); players.set(to, p); p.path = to; }
    queueChanged();
  };
  app.vault.bus.on("fileRenamed", renamed);
  // files deleted (here or outside): out of the queue and the playlists. Only
  // files seen this session count, so a vault still loading loses nothing;
  // the pause lets a rename (listed as gone, then renamed) arrive first.
  const mediaNow = () => new Set([...app.vault.files.values()].filter((f) => f.kind === "media" || AUDIO.test(f.path)).map((f) => f.path));
  let seen = mediaNow();
  app.vault.bus.on("structure", debounce(() => {
    const now = mediaNow();
    const gone = new Set([...seen].filter((k) => !now.has(k)));
    seen = now;
    if (!gone.size) return;
    if (cur && gone.has(cur.key)) stop();
    const drop = queue.items.map((k, i) => (gone.has(k) ? i : -1)).filter((i) => i >= 0).reverse();
    if (drop.length) { for (const i of drop) Q.remove(queue, i); queueChanged(); }
    const pls = lists();
    if (pls.some((p) => p.items.some((k) => gone.has(k)))) saveLists(pls.map((p) => ({ ...p, items: p.items.filter((k) => !gone.has(k)) })));
    for (const k of gone) if (players.has(k)) dispose(k);
  }, 700));
  app.vault.bus.on("folderRenamed", renamed);

  // "Play in Leonote" from a YouTube embed in a note
  document.addEventListener("leonote:youtube", async (e) => {
    const d = e.detail || {};
    const key = await addYouTube({ id: d.id, start: d.start });
    if (!key) return;
    if (d.queue) { enqueue([key]); app.toast("Added to the queue", { ms: 1800 }); }
    else { const i = enqueue([key], { next: true }); playAt(i); }
  });

  /* ── playlists (kept in settings; exportable as .m3u8) ───────────────── */
  const lists = () => (Array.isArray(S.playlists) ? S.playlists : []);
  // `fromYouTube`: a read of YouTube's list - nothing to send back, nothing to remember as taken out
  const saveLists = (v, fromYouTube = false) => {
    if (!fromYouTube) {
      const before = new Map(lists().map((p) => [p.id, p]));
      v = v.map((p) => {
        const o = before.get(p.id);
        if (!o || !p.ytList || o.items === p.items) return p;
        const was = new Set(o.items), now = new Set(p.items);
        const added = p.items.filter((k) => Q.isYt(k) && !was.has(k));
        const removed = o.items.filter((k) => Q.isYt(k) && !now.has(k));
        if (!added.length && !removed.length) return p;
        // "Send my changes to YouTube": the same change in the YouTube playlist
        if (p.ytPush && playlists.pushTo) playlists.pushTo(p, added, removed);
        // taken out here: the daily read of YouTube's list does not bring it back - and it is listed
        // under the playlist by name, to restore
        const skip = new Set(p.ytSkip || []);
        for (const k of removed) skip.add(k);
        for (const k of added) skip.delete(k);
        const names = { ...(p.ytSkipNames || {}) };
        for (const k of removed) { const e = entryOf(k); if (e && e.title) names[k] = e.title; }
        for (const k of Object.keys(names)) if (!skip.has(k)) delete names[k];
        // added here: not YouTube's, so never "taken out on YouTube" while its list lacks it
        const mine = new Set(p.ytMine || []);
        for (const k of added) mine.add(k);
        for (const k of removed) mine.delete(k);
        return { ...p, ytSkip: [...skip], ytMine: [...mine], ytSkipNames: names };
      });
    }
    app.setSetting("playlists", v);
    emit("library");
  };
  const playlists = {
    all: lists,
    // `extra` carries an imported list's own facts: where it came from and
    // its full track names, including the ones this computer does not have
    create(name, keys = [], extra = null) {
      const pl = { id: Math.random().toString(36).slice(2, 10), name: name || "Playlist", items: [...new Set(keys)], updatedAt: Date.now(), color: Math.floor(Math.random() * 360), ...(extra || {}) };
      saveLists([...lists(), pl]);
      return pl;
    },
    add(id, keys) { saveLists(lists().map((p) => (p.id === id ? { ...p, items: [...new Set([...p.items, ...keys])], updatedAt: Date.now() } : p))); },
    set(id, items, extra = null, fromYouTube = false) { saveLists(lists().map((p) => (p.id === id ? { ...p, items, ...(extra || {}), updatedAt: Date.now() } : p)), fromYouTube); },
    /** A playlist's own facts changed (its switches), its videos untouched. */
    patch(id, extra) { saveLists(lists().map((p) => (p.id === id ? { ...p, ...extra } : p)), true); },
    /** Every local song the matcher can choose from (vault and libraries). */
    candidates() {
      const out = [];
      const add = (key) => {
        const m = metaOf(key);
        if (m) out.push({ key, title: m.title || key, artist: m.artist || "", album: m.album || "", duration: m.duration || 0 });
      };
      for (const f of app.vault.files.values()) if (f.kind === "media" || AUDIO.test(f.path)) add(f.path);
      for (const f of libEntries.values()) if (f.kind === "media") add(f.path);
      return out;
    },
    rename(id, name) { saveLists(lists().map((p) => (p.id === id ? { ...p, name } : p))); },
    remove(id) { saveLists(lists().filter((p) => p.id !== id)); },
    /** Every playlist as it was (an undo). */
    restore(all) { saveLists(all); },
    async export(id) {
      const pl = lists().find((p) => p.id === id);
      if (!pl) return null;
      const text = Q.toM3u8(pl.name, pl.items, (k) => ({ ...metaOf(k), duration: (metaOf(k) || {}).duration }));
      const safe = pl.name.replace(/[<>:"/\\|?*]+/g, " ").trim() || "Playlist";
      const dir = String(app.settings.playlistFolder || "Utilities/Media/Playlists").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      return app.host.importFile(`${dir}/${safe}.m3u8`, new TextEncoder().encode(text));
    },
  };

  return {
    // file tabs (unchanged contract)
    view, park, dispose, pill, bus, menuAt: pillMenu, requeue,
    isPlaying: (path) => (path === undefined ? isPlaying() : (() => { const p = players.get(path); return !!p && !p.el.paused; })()),
    has: (path) => players.has(path),
    // the engine
    queue, current: () => cur && cur.key, playing: isPlaying,
    play, pause, toggle, next, prev, seek, stop, time, duration,
    playKey, playAt, playList, enqueue,
    removeAt(i) {
      const wasCur = i === queue.index;
      Q.remove(queue, i);
      queueChanged();
      if (wasCur && cur) { const k = Q.current(queue); if (k && isPlaying()) playKey(k); else if (!k) stop(); }
    },
    move(from, to) { Q.move(queue, from, to); queueChanged(); },
    clearQueue() {
      const k = cur && cur.key, was = queue.items, wasAt = queue.index;
      Q.setItems(queue, k ? [k] : [], 0);
      queueChanged();
      if (was.length > queue.items.length) app.toast("Queue cleared", { ms: 8000, action: { label: "Undo", run: () => {
        const now = Q.current(queue), items = [...was, ...queue.items];
        Q.setItems(queue, items, now ? items.indexOf(now) : wasAt);
        queueChanged();
      } } });
    },
    setShuffle, cycleRepeat, setVolume, toggleMute, setRate, speedPop,
    /** The playing file's own element (not YouTube's), for the Sound panel. */
    mediaEl: () => (cur && !cur.yt && cur.p ? cur.p.el : null),
    /** Where a key's file can be fetched from (analysis reads it). */
    srcOf: (key) => srcUrl(app, key),
    setKeepPitch(on) { keepPitch = !!on; applyLevels(); },
    miniPlayer: () => miniPlayer(),
    get volume() { return volume; }, get muted() { return muted; }, get rate() { return rate; },
    setSleep, sleepInfo: () => ({ at: sleepAt, track: sleepEnd }),
    graph, get graphReady() { return !!(audioGraph && audioGraph.ready); }, audio: () => audioGraph,
    videoEl: () => (cur && cur.p && !cur.p.audio ? cur.p.el : null),
    isYouTube: () => !!(cur && cur.yt),
    yt: () => yt,
    setStage, showYtTile() { ytTileHidden = false; app.setSetting("playerYtTileHidden", false); ytAway(); },
    metaOf, metaReady, libraries, outsideKey, outsideAbs: (k) => outside.get(k) || (Q.isLib(k) ? diskPath(k) : ""),
    youtube: { list: ytLib, add: addYouTube, remove: removeYouTube, setTitle: setYtTitle, fillTitles },
    batch,
    online: { list: allOnline, keyOf: keyOfEntry, entry: entryOf, add: addOnline, addMany: addManyOnline, remove: removeOnline, replaceKey, thumb: ytThumbUrl,
      previewsDir: () => kept.dir, refreshPreviews, smallPictures,
      restore: (list) => { app.setSetting("youtubeLibrary", list); emit("library"); },
      /** Some facts set on one entry (loose: it was added on its own, not only through a playlist). */
      name: nameOnline,
      mark: (key, fields) => { const lib = allOnline(); if (!lib.some((x) => keyOfEntry(x) === key)) return; app.setSetting("youtubeLibrary", lib.map((x) => (keyOfEntry(x) === key ? { ...x, ...fields } : x))); emit("library"); },
      rename: (key, title) => { app.setSetting("youtubeLibrary", allOnline().map((x) => (keyOfEntry(x) === key ? { ...x, title, named: true } : x))); emit("library"); changed(); } },
    playlists,
    togglePip,
  };
}

export function togglePip(el) {
  if (!el || !document.pictureInPictureEnabled) return Promise.resolve();
  return (document.pictureInPictureElement === el ? document.exitPictureInPicture() : el.requestPictureInPicture()).catch(() => {});
}
