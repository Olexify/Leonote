// An online video's own small window (ytmini.html), on top and in sight while Leonote is minimized or in the tray:
// YouTube's player terms ask for a player that is seen. The main window hands the video over (id and time) and
// takes it back at the time it reached; closing this window pauses the video.
import { createYouTubePlayer } from "./youtube.js";

const T = window.__TAURI__;
const $ = (id) => document.getElementById(id);
const send = (p) => T.event.emitTo("main", "ytmini:cmd", p);
const win = T.window.getCurrentWindow();

const player = createYouTubePlayer({
  state: (s) => { if (s === "ended") send({ cmd: "ended" }); else report(); },
  title: (t) => { $("name").textContent = t; },
  error: (m) => { $("msg").textContent = m; $("msg").hidden = false; send({ cmd: "error", at: player.time() }); },
}, { controls: true });

const report = () => send({ cmd: "state", at: player.time(), playing: !player.paused() });
setInterval(report, 1000);

T.event.listen("ytmini:load", (e) => {
  const p = e.payload || {};
  if (typeof p.id !== "string" || !/^[\w-]{6,20}$/.test(p.id)) return;
  if (p.title) $("name").textContent = p.title;
  player.load(p.id, { start: Math.max(0, Number(p.start) || 0), play: p.play !== false }).catch((err) => { $("msg").textContent = String(err && err.message || err); $("msg").hidden = false; });
}).then(() => send({ cmd: "hello" }));

$("back").onclick = () => { send({ cmd: "back", at: player.time(), playing: !player.paused() }); };
$("close").onclick = () => { player.pause(); send({ cmd: "closed", at: player.time() }); win.close(); };
$("bar").addEventListener("mousedown", (e) => { if (e.button === 0 && !e.target.closest("button")) win.startDragging(); });
$("grip").addEventListener("mousedown", (e) => { if (e.button === 0) { e.preventDefault(); win.startResizeDragging("SouthEast"); } });
