// A break's card on the desktop (breakpop.html) while Leonote is minimized or in the tray: the in-app break card, in a
// small window of its own. The main window sends what the break asks for, with the app's theme and accent, so it looks
// like Leonote does right now; a click ticks one off there. The window takes the height of what it shows until it is
// resized by hand (the corner grip); a line along the bottom runs down to when it goes.
import { icon } from "./icons.js";

const T = window.__TAURI__;
const $ = (id) => document.getElementById(id);
const send = (p) => T.event.emitTo("main", "breakpop:cmd", p);
const win = T.window.getCurrentWindow();
let sized = false; // resized by hand: the height is the user's from then on
let run = 0;
let prefs = {}, showPrefs = false; // the card's own settings, and whether its gear has them open

let headIco = icon("dumbbell");
$("ico").replaceWith(headIco);
$("settings").append(icon("settings"));
$("close").append(icon("x"));

function fit() {
  if (sized) return;
  const h = Math.ceil($("card").scrollHeight) + 2;
  win.setSize(new T.window.LogicalSize(window.innerWidth, Math.min(420, Math.max(100, h)))).catch(() => {});
}
function clock(endAt) {
  clearTimeout(run);
  if (!endAt) { $("clock").hidden = true; return; }
  $("clock").hidden = false;
  const total = Math.max(1, endAt - Date.now());
  const tick = () => {
    const left = Math.max(0, endAt - Date.now());
    $("clockFill").style.width = `${(left / total) * 100}%`;
    if (left > 0) run = setTimeout(tick, 1000); // once a second is enough for a thin line
  };
  tick();
}
// the app's look as it is now: light or dark, the accent and the other settings kept on its root
function look(l) {
  if (!l) return;
  const root = document.documentElement;
  if (l.theme) root.dataset.theme = l.theme;
  if (typeof l.style === "string") root.setAttribute("style", l.style);
}
function paint(st) {
  if (!st) return;
  look(st.look);
  $("title").textContent = st.title || "Break";
  const items = st.items || [];
  const eyes = items.length > 0 && items.every((it) => it.kind === "eyes"); // a minute for the eyes: an eye, else a dumbbell
  const next = icon(eyes ? "eye" : "dumbbell");
  headIco.replaceWith(next);
  headIco = next;
  $("list").replaceChildren(...(st.items || []).map((it) => {
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!it.done });
    box.setAttribute("aria-label", it.name || "");
    box.onclick = (e) => e.preventDefault(); // the row decides; the tick comes back from the app
    const name = Object.assign(document.createElement("span"), { className: "db-name", textContent: it.name || "" });
    const sub = Object.assign(document.createElement("span"), { className: "db-sub", textContent: it.sub || "" });
    const row = document.createElement("div");
    row.className = "db-row" + (it.done ? " is-done" : "");
    row.tabIndex = 0;
    row.setAttribute("role", "checkbox");
    row.setAttribute("aria-checked", String(!!it.done));
    row.append(box, icon(it.kind === "eyes" ? "eye" : it.kind === "water" ? "drop" : it.kind === "habit" ? "flame" : "dumbbell"), name, sub);
    const tick = () => send({ cmd: "tick", id: it.id, done: !it.done });
    row.onclick = tick;
    row.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); tick(); } };
    return row;
  }));
  if (st.prefs) prefs = st.prefs;
  drawPrefs();
  if (st.endAt !== undefined) clock(st.endAt);
  requestAnimationFrame(fit);
}
// the gear: this card's settings, on the card - changed here, kept by Leonote (Timer page, the same switches)
function drawPrefs() {
  $("list").hidden = showPrefs;
  $("prefs").hidden = !showPrefs;
  $("settings").classList.toggle("is-on", showPrefs);
  $("open").textContent = showPrefs ? "All break settings in Leonote" : "Open Leonote";
  if (!showPrefs) return;
  $("prefs").replaceChildren(...[["voice", "Say it out loud"], ["stay", "Keep it until closed"], ["pop", "On the desktop when Leonote is hidden"]].map(([key, label]) => {
    const on = !!prefs[key];
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: on });
    box.onclick = (e) => e.preventDefault();
    const row = document.createElement("div");
    row.className = "db-row";
    row.tabIndex = 0;
    row.setAttribute("role", "switch");
    row.setAttribute("aria-checked", String(on));
    row.append(box, Object.assign(document.createElement("span"), { className: "db-name", textContent: label }));
    const flip = () => { prefs[key] = !on; drawPrefs(); send({ cmd: "set", key, value: !on }); };
    row.onclick = flip;
    row.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } };
    return row;
  }));
}
T.event.listen("breakpop:show", (e) => paint(e.payload)).then(() => send({ cmd: "hello" }));
$("close").onclick = () => { send({ cmd: "closed" }); win.close(); };
addEventListener("keydown", (e) => { if (e.key === "Escape") $("close").onclick(); });
$("settings").onclick = () => { showPrefs = !showPrefs; drawPrefs(); requestAnimationFrame(fit); };
$("open").onclick = () => send({ cmd: showPrefs ? "settings" : "open" });
$("head").addEventListener("mousedown", (e) => { if (e.button === 0 && !e.target.closest("button")) win.startDragging(); });
$("grip").addEventListener("mousedown", (e) => { if (e.button === 0) { e.preventDefault(); sized = true; win.startResizeDragging("SouthEast"); } });
