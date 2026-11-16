// The mini player's window (mini.html). Its own file: the app's policy allows no inline script.
const T = window.__TAURI__;
const $ = (id) => document.getElementById(id);
const send = (cmd) => T && T.event.emitTo("main", "mini:cmd", { cmd });
const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
let last = null;
let dragging = false;
const place = (f) => { $("fill").style.width = f * 100 + "%"; $("knob").style.left = f * 100 + "%"; };
function paint(st) {
  if (!st) return;
  const root = document.body.style;
  if (st.bg) root.setProperty("--bg", st.bg);
  if (st.fg) root.setProperty("--fg", st.fg);
  if (st.dim) root.setProperty("--dim", st.dim);
  if (st.accent) root.setProperty("--accent", st.accent);
  $("name").textContent = st.title || "Nothing playing";
  $("name").title = st.title || "";
  $("time").textContent = st.title ? fmt(st.time) + (st.duration ? " / " + fmt(st.duration) : "") : "";
  last = st;
  if (!dragging) place(st.duration ? Math.min(1, st.time / st.duration) : 0);
  $("art").style.backgroundImage = st.cover ? `url("${st.cover}")` : st.gradient || "";
  $("art").classList.toggle("has-cover", !!st.cover);
  if (!st.video) $("art").classList.remove("is-video");
  $("playIco").innerHTML = $("tinyIco").innerHTML = st.playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5.5v13l11-6.5z"/>';
}
// the timeline takes the pointer: nothing moves in the player until it is let go
const bar = $("fill").parentElement;
const frac = (e) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
bar.addEventListener("pointerdown", (e) => { if (e.button !== 0 || !last || !last.duration) return; e.preventDefault(); e.stopPropagation(); dragging = true; bar.classList.add("is-drag"); bar.setPointerCapture(e.pointerId); place(frac(e)); });
bar.addEventListener("pointermove", (e) => { if (!dragging) return; const f = frac(e); place(f); $("time").textContent = fmt(f * last.duration) + " / " + fmt(last.duration); });
for (const ev of ["pointerup", "pointercancel"]) bar.addEventListener(ev, (e) => { if (!dragging) return; dragging = false; bar.classList.remove("is-drag"); if (ev === "pointerup" && T) T.event.emitTo("main", "mini:cmd", { cmd: "seek", at: frac(e) * last.duration }); });
bar.addEventListener("mousedown", (e) => e.stopPropagation());
// the card lays itself out by the room it has
const fit = () => {
  const w = innerWidth, h = innerHeight;
  const tiny = w < 150 && h < 150 || w < 110 || h < 64;
  document.body.classList.toggle("is-tiny", tiny);
  document.body.classList.toggle("is-tall", !tiny && h >= 170);
  document.body.classList.toggle("is-narrow", !tiny && h < 170 && w < 300);
};
addEventListener("resize", fit);
fit();
$("grip").addEventListener("mousedown", (e) => { if (e.button !== 0 || !T) return; e.preventDefault(); e.stopPropagation(); T.window.getCurrentWindow().startResizeDragging("SouthEast"); });
// tiny: the picture is the button (a press that does not turn into a drag)
let downAt = null;
$("art").addEventListener("mousedown", (e) => { downAt = [e.screenX, e.screenY]; });
$("art").addEventListener("mouseup", (e) => { if (document.body.classList.contains("is-tiny") && downAt && Math.abs(e.screenX - downAt[0]) + Math.abs(e.screenY - downAt[1]) < 4) send("toggle"); downAt = null; });
$("prev").onclick = () => send("prev");
$("next").onclick = () => send("next");
$("play").onclick = () => send("toggle");
$("open").onclick = () => send("open");
$("close").onclick = () => { send("closed"); T.window.getCurrentWindow().close(); };
// the whole card drags the window, the buttons excepted
document.body.addEventListener("mousedown", (e) => { if (e.button === 0 && !e.target.closest("button, .bar, .grip")) T.window.getCurrentWindow().startDragging(); });
window.addEventListener("keydown", (e) => { if (e.key === " ") { e.preventDefault(); send("toggle"); } else if (e.key === "Escape") $("close").onclick(); });
if (T) {
  T.event.listen("mini:state", (e) => paint(e.payload));
  // a video shows in the square itself: small frames sent over from the player
  T.event.listen("mini:frame", (e) => { if (e.payload && e.payload.src) { $("frame").src = e.payload.src; $("art").classList.add("is-video"); } });
  send("hello");
}
