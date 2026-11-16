// What a plugin's sandboxed frame runs (plugins.js makes the frame): the small `leonote` API, by messages to the app,
// then the plugin's own script. A plain script, not a module, loaded by the frame from the app.
(() => {
  // nothing of the host may be reached from the plugin's code
  for (const k of Object.keys(window)) if (/^__TAURI|^__tauri|ipc/i.test(k)) try { delete window[k]; } catch {}
  // the frame's policy stops the other ways out, but an engine may ignore its webrtc line: this makes WebRTC harder, not
  // impossible (a frame the plugin makes inside its page has its own copy) - a Worker for plugin code would close it
  for (const k of Object.getOwnPropertyNames(window)) if (/RTC/.test(k)) try { delete window[k]; window[k] = undefined; } catch {}
  // document.open (and write, which opens) wipes every listener, the guard below too; for good, and the frame's
  // policy allows no new realm to fetch clean copies from
  for (const k of ["open", "write", "writeln"]) Object.defineProperty(Document.prototype, k, { value() { throw new Error(`document.${k} is not available to a plugin`); }, writable: false, configurable: false });

  // kept now: a plugin's code can replace window.parent, and the check below would then trust whoever it names
  const host = window.parent;
  const post = (m) => host.postMessage(m, "*");
  const waiting = new Map();
  const commands = new Map();
  let seq = 0;
  const ask = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    post({ type: "plugin-call", id, method, args });
  });

  window.leonote = Object.freeze({
    commands: Object.freeze({ add: (id, name, run) => { commands.set(String(id), run); return ask("commands.add", String(id), String(name)); } }),
    panel: Object.freeze({ show: () => ask("panel.show"), hide: () => ask("panel.hide") }),
    notes: Object.freeze({
      list: () => ask("notes.list"),
      read: (path) => ask("notes.read", path),
      write: (path, text, why) => ask("notes.write", path, text, why),
      append: (path, text, why) => ask("notes.append", path, text, why),
    }),
    net: Object.freeze({ fetch: (url) => ask("net.fetch", url) }),
  });

  addEventListener("error", (e) => post({ type: "plugin-error", text: String(e.message || "error") }));
  addEventListener("unhandledrejection", (e) => post({ type: "plugin-error", text: String((e.reason && e.reason.message) || e.reason) }));

  // from the app only: another frame could answer for it, run its command, or hand it what that frame may read. A frame
  // cannot be kept from sending, so nothing another frame sends gets past this: it is the first listener, before the
  // plugin's script exists, and that script cannot take it away
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== host) { e.stopImmediatePropagation(); return; }
    if (!m) return;
    if (m.type === "plugin-reply") {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.ok) w.resolve(m.value); else w.reject(new Error(m.error));
    } else if (m.type === "plugin-command") {
      const run = commands.get(m.id);
      if (run) run();
    } else if (m.type === "plugin-run") {
      // the plugin's script as a script of its own, from a blob: address (no eval: the policy allows none)
      const url = URL.createObjectURL(new Blob([m.code], { type: "text/javascript" }));
      const s = document.createElement("script");
      s.onload = s.onerror = () => { URL.revokeObjectURL(url); s.remove(); };
      s.src = url;
      document.head.append(s);
    }
  }, true);
  post({ type: "plugin-ready" });
})();
