// A break's card on the desktop (breakpop.html) while Leonote is minimized or in the tray. The main window sends
// what the break asks for; a click ticks one off there. The window takes the height of what it shows, until it is
// resized by hand (the corner grip); a line along the bottom runs down to when it goes.
const T = window.__TAURI__;
const $ = (id) => document.getElementById(id);
const send = (p) => T.event.emitTo("main", "breakpop:cmd", p);
const win = T.window.getCurrentWindow();
let sized = false; // resized by hand: the height is the user's from then on
let run = 0;

function fit() {
  if (sized) return;
  const h = Math.ceil($("card").scrollHeight) + 8;
  win.setSize(new T.window.LogicalSize(window.innerWidth, Math.min(420, Math.max(100, h)))).catch(() => {});
}
function clock(endAt) {
  clearTimeout(run);
  if (!endAt) { $("clock").hidden = true; return; }
  $("clock").hidden = false;
  const total = Math.max(1, endAt - Date.now());
  const tick = () => {
    const left = Math.max(0, endAt - Date.now());
    $("clockFill").style.transform = `scaleX(${left / total})`;
    if (left > 0) run = setTimeout(tick, 1000); // once a second is enough for a thin line
  };
  tick();
}
function paint(st) {
  if (!st) return;
  $("title").textContent = st.title || "Break";
  $("list").replaceChildren(...(st.items || []).map((it) => {
    const row = document.createElement("button");
    row.className = "row" + (it.done ? " is-done" : "");
    row.setAttribute("role", "checkbox");
    row.setAttribute("aria-checked", String(!!it.done));
    const box = document.createElement("i"); box.className = "box";
    const name = document.createElement("span"); name.className = "name"; name.textContent = it.name || "";
    const sub = document.createElement("span"); sub.className = "sub"; sub.textContent = it.sub || "";
    row.append(box, name, sub);
    row.onclick = () => send({ cmd: "tick", id: it.id, done: !it.done });
    return row;
  }));
  if (st.endAt !== undefined) { clearTimeout(run); clock(st.endAt); }
  requestAnimationFrame(fit);
}
T.event.listen("breakpop:show", (e) => paint(e.payload)).then(() => send({ cmd: "hello" }));
$("close").onclick = () => { send({ cmd: "closed" }); win.close(); };
addEventListener("keydown", (e) => { if (e.key === "Escape") $("close").onclick(); });
$("settings").onclick = () => send({ cmd: "settings" });
$("open").onclick = () => send({ cmd: "open" });
$("head").addEventListener("mousedown", (e) => { if (e.button === 0 && !e.target.closest("button")) win.startDragging(); });
$("grip").addEventListener("mousedown", (e) => { if (e.button === 0) { e.preventDefault(); sized = true; win.startResizeDragging("SouthEast"); } });
