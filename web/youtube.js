import { deadline } from "./util.js";
// YouTube, lightweight: link parsing (pure), the IFrame API loaded only when a
// video first plays, and one player that never moves in the DOM (an iframe
// reloads when it is re-parented). It floats over whatever placeholder the
// Player view gives it, or shrinks to a small tile in the corner.

const ID = /^[A-Za-z0-9_-]{11}$/;

/** { id, list, start } from any YouTube link (or a bare 11-char id), else null. */
export function parseYouTube(input) {
  const s = String(input || "").trim();
  if (ID.test(s)) return { id: s };
  let u;
  try { u = new URL(/^https?:/i.test(s) ? s : "https://" + s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id = "";
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const p = u.pathname.split("/").filter(Boolean);
    if (p[0] === "watch") id = u.searchParams.get("v") || "";
    else if (["shorts", "embed", "live", "v", "e"].includes(p[0])) id = p[1] || "";
    else if (p[0] !== "playlist") return null;
  } else return null;
  const list = u.searchParams.get("list") || "";
  if (id && !ID.test(id)) return null;
  if (!id && !list) return null;
  const t = u.searchParams.get("t") || u.searchParams.get("start") || "";
  const tm = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  const start = tm ? (+tm[1] || 0) * 3600 + (+tm[2] || 0) * 60 + (+tm[3] || 0) : 0;
  const out = {};
  if (id) out.id = id;
  if (list) out.list = list;
  if (start) out.start = start;
  return out;
}

export const ytThumb = (id, q = "hqdefault") => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
export const ytWatch = (id) => `https://www.youtube.com/watch?v=${id}`;

/** The title from oEmbed; null when the network or CORS says no. */
const thumbWidth = (id) => (typeof Image === "undefined" ? Promise.resolve(0) : new Promise((res) => {
  const im = new Image();
  im.onload = () => res(im.naturalWidth);
  im.onerror = () => res(0);
  im.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}));
export async function ytTitle(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(ytWatch(id))}&format=json`, { signal: deadline(15000) });
    // 401 is also what a video its owner lets play only on YouTube answers: alive, so not gone - unless
    // its picture is YouTube's grey stand-in (120 px wide), which a removed or private video has
    // (without the player to ask, a grey picture is not proof enough to call it gone: unknown, asked again later)
    if (r.status === 401) return (await thumbWidth(id)) > 120 ? { title: "", author: "", webOnly: true } : null;
    if (r.status === 404 || r.status === 403) return { gone: true };
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.title ? { title: j.title, author: j.author_name || "", authorUrl: j.author_url || "" } : null;
  } catch { return null; }
}

/** A gone video's facts at a check: when it was first found gone, and after 30 days its stored name dropped
 *  (YouTube's developer policies, III.E.4) unless the user named it - a removed one's name cannot be refreshed. */
export const GONE_KEEP = 30 * 86400000;
export function goneFields(x, gone, now) {
  if (!gone) return x.goneAt ? { goneAt: 0 } : {};
  const goneAt = x.goneAt || now;
  return now - goneAt > GONE_KEEP && x.title && !x.named ? { goneAt, title: "" } : { goneAt };
}

const YT_HOST = "https://www.youtube-nocookie.com";
/** Under what YouTube's required minimum asks of a 16:9 player, 200 px high so 356 wide - of what shows, `cut` (top, right, bottom, left) taken off. */
export const belowLeast = (r, cut = [0, 0, 0, 0]) => r.width - cut[1] - cut[3] < 356 || r.height - cut[0] - cut[2] < 200;
let nextId = 0;

const ERRORS = { 2: "This link is not a valid video", 5: "The video cannot play here", 100: "The video was removed or is private", 101: "The owner doesn't allow playing this video outside its site", 150: "The owner doesn't allow playing this video outside its site", 153: "The site refused to play it here" };

/**
 * One floating YouTube player. `on` gets: ready, state("playing"|"paused"|
 * "ended"|"buffering"), error(message, code), title(text).
 */
export function createYouTubePlayer(on, { controls = true, least = false } = {}) {
  const layer = document.createElement("div");
  layer.className = "yt-layer is-off";
  const mount = document.createElement("div");
  layer.append(mount);
  document.body.append(layer);
  let yt = null; // the embed's frame, once made
  let ready = null;
  // what the player last told us (it reports several times a second while it plays)
  let info = { currentTime: 0, duration: 0, playerState: -1, videoData: null };
  let at = 0; // when currentTime was told: the time in between is counted here, as YouTube's own script does
  let wanted = null; // { id, start, play }
  let anchor = null;
  let mode = "off"; // off | anchored | mini | hidden
  let rectTimer = 0;
  let lastRect = "";

  /**
   * The player is YouTube's embed in a frame of its own, spoken to by messages - the same ones YouTube's
   * iframe_api script sends, without that script running in Leonote's window (where it could reach the app).
   */
  const send = (func, args = []) => { if (yt && yt.contentWindow) yt.contentWindow.postMessage(JSON.stringify({ event: "command", func, args, id: frameId, channel: "widget" }), YT_HOST); };
  const frameId = ++nextId;
  function ensure() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const vars = new URLSearchParams({ enablejsapi: "1", playsinline: "1", rel: "0", iv_load_policy: "3", controls: controls ? "1" : "0", widgetid: String(frameId) });
      if (location.origin.startsWith("http")) vars.set("origin", location.origin);
      yt = document.createElement("iframe");
      yt.src = YT_HOST + "/embed/?" + vars;
      yt.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      yt.allowFullscreen = true;
      yt.referrerPolicy = "strict-origin-when-cross-origin";
      Object.assign(yt.style, { width: "100%", height: "100%", border: "0" });
      let hello = 0;
      const fail = setTimeout(() => { done(); ready = null; yt.replaceWith(mount); yt = null; reject(new Error("The online player did not load (offline?)")); }, 15000);
      const done = () => { clearInterval(hello); window.removeEventListener("message", onMsg); };
      const onMsg = (e) => {
        if (!yt || e.source !== yt.contentWindow || e.origin !== YT_HOST) return;
        let m; try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
        if (!m || typeof m !== "object") return;
        clearInterval(hello); // it answered: no need to keep calling
        if (m.event === "onReady") {
          clearTimeout(fail);
          // the events it should send, asked for as YouTube's script asks
          for (const ev of ["onStateChange", "onError"]) send("addEventListener", [ev]);
          resolve(yt); on.ready && on.ready();
        }
        else if (m.event === "infoDelivery" || m.event === "initialDelivery") {
          if (m.info && typeof m.info === "object") { Object.assign(info, m.info); if ("currentTime" in m.info) at = performance.now(); }
        } else if (m.event === "onStateChange") {
          info.playerState = m.info;
          const st = { 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "cued" }[m.info];
          if (st) on.state && on.state(st);
          if (st === "playing") { const d = info.videoData; if (d && d.title) on.title && on.title(d.title, d.video_id); }
        } else if (m.event === "onError") on.error && on.error(ERRORS[m.info] || "This online video could not play", m.info);
      };
      window.addEventListener("message", onMsg);
      // the embed listens once it has loaded; it is told so until it answers, as YouTube's script does
      yt.addEventListener("load", () => {
        const call = () => { if (yt && yt.contentWindow) yt.contentWindow.postMessage(JSON.stringify({ event: "listening", id: frameId, channel: "widget" }), YT_HOST); };
        call(); clearInterval(hello); hello = setInterval(call, 250);
      });
      mount.replaceWith(yt);
    });
    return ready;
  }
  const now = () => info.currentTime + (info.playerState === 1 && at ? ((performance.now() - at) / 1000) * (info.playbackRate || 1) : 0);

  function place() {
    if (mode !== "anchored" || !anchor || !anchor.isConnected) return;
    const r = anchor.getBoundingClientRect();
    // a fixed layer knows nothing of the scroller its anchor lives in: cut
    // away what that scroller hides, as it would for any child of its own
    const box = anchor.closest(".view, [data-yt-clip]");
    const c = box && getComputedStyle(anchor.closest(".pv-now") || anchor).position !== "fixed" ? box.getBoundingClientRect() : null;
    const cut = c ? [Math.max(0, c.top - r.top), Math.max(0, r.right - c.right), Math.max(0, r.bottom - c.bottom), Math.max(0, c.left - r.left)].map((n) => Math.round(n)) : [0, 0, 0, 0];
    // `least`: a place showing too little for YouTube's least (too small, or scrolled away) leaves the video in the corner tile, until it shows enough
    if (least) {
      const small = belowLeast(r, cut);
      layer.classList.toggle("is-mini", small);
      layer.classList.toggle("is-anchored", !small);
      if (small) { if (lastRect) { layer.removeAttribute("style"); lastRect = ""; } return; }
    }
    const key = `${r.left}|${r.top}|${r.width}|${r.height}|${cut}`;
    if (key === lastRect) return;
    lastRect = key;
    Object.assign(layer.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", clipPath: cut.some(Boolean) ? `inset(${cut.map((n) => n + "px").join(" ")} round 0)` : "" });
  }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
  let slowTimer = 0, calmSince = 0, lastSeen = "";
  function follow() {
    rectTimer = 0; slowTimer = 0;
    if (mode !== "anchored") return;
    place();
    const now = performance.now();
    if (lastRect !== lastSeen) { lastSeen = lastRect; calmSince = now; }
    if (now - calmSince < 1000) rectTimer = requestAnimationFrame(follow);
    else slowTimer = setTimeout(follow, 500);
  }
  const kickFollow = () => { if (mode !== "anchored") return; calmSince = performance.now(); clearTimeout(slowTimer); slowTimer = 0; if (!rectTimer) rectTimer = requestAnimationFrame(follow); };
  if (typeof document !== "undefined" && document.addEventListener) {
    for (const ev of ["scroll", "pointerdown", "pointerup", "wheel", "keydown"]) document.addEventListener(ev, kickFollow, { capture: true, passive: true });
    addEventListener("resize", kickFollow);
  }

  function setMode(m, el) {
    if (ro) ro.disconnect();
    cancelAnimationFrame(rectTimer); rectTimer = 0;
    clearTimeout(slowTimer); slowTimer = 0;
    calmSince = performance.now();
    mode = m;
    anchor = m === "anchored" ? el : null;
    lastRect = "";
    layer.className = "yt-layer is-" + m;
    if (m === "anchored" && anchor) {
      if (ro) ro.observe(anchor);
      // layout around the anchor can move it without resizing it (a drag,
      // theatre, a scroll): followed frame by frame for a second after anything moves, then twice a second - a video
      // left playing or paused no longer keeps the window drawing at the screen's rate
      follow();
    } else layer.removeAttribute("style");
    if (typeof dispatchEvent === "function") dispatchEvent(new Event("leo:overlay")); // the mini tile came or went over a page
  }

  return {
    layer,
    async load(id, { start = 0, play = true } = {}) {
      wanted = { id, start, play };
      const p = await ensure();
      if (!wanted || wanted.id !== id) return;
      if (!p) return;
      info = { currentTime: start, duration: 0, playerState: -1, videoData: null }; at = 0;
      send(play ? "loadVideoById" : "cueVideoById", [{ videoId: id, startSeconds: start }]);
    },
    play: () => send("playVideo"),
    pause: () => send("pauseVideo"),
    stop() { wanted = null; send("stopVideo"); setMode("off"); },
    seek: (t) => { send("seekTo", [t, true]); info.currentTime = t; at = performance.now(); },
    time: () => (yt ? now() || 0 : 0),
    duration: () => (yt ? info.duration || 0 : 0),
    paused: () => !yt || info.playerState !== 1,
    setVolume: (v, muted) => { if (!yt) return; send("setVolume", [Math.round(v * 100)]); send(muted ? "mute" : "unMute"); },
    setRate: (r) => send("setPlaybackRate", [r]),
    title: () => (info.videoData && info.videoData.title) || "",
    get loaded() { return !!yt; },
    get mode() { return mode; },
    get tile() { return layer.classList.contains("is-mini"); }, // in the corner, its own choice or for want of room
    anchor: (el) => setMode("anchored", el),
    mini: () => setMode("mini"),
    hide: () => setMode("hidden"),
    place,
  };
}
