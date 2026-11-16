// A microphone button on the browser's own speech recogniser (Chrome has
// one; WebView2 mostly has not). It never hides itself: a refused permission
// is often a misclick, so the button stays and the next click asks again.
// When there is no service behind it, the button says so in its tooltip and
// a toast, and still stays - the answer can change with the runtime.

import { h } from "./util.js";
import { icon } from "./icons.js";
import { toast, menu } from "./ui.js";
import { record, transcribe, speechOf } from "./speech.js";

const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
// in the app Windows listens (Windows.Media.SpeechRecognition through voice_listen); the page's own recogniser is for the browser mock
const native = () => !!(window.leonote && window.leonote.host && window.leonote.host.real);
export const hasVoice = () => native() || !!SR();

/**
 * `onText(said)` gets the transcript. Returns the button (a `.voice-btn`,
 * `.is-on` while listening, `.is-off` after a failure) - or null when the
 * page has no recogniser at all.
 */
export function voiceButton({ onText, title = "Say it", cls = "icon-btn", lang } = {}) {
  const Rec = SR();
  if (!Rec && !native()) return null;
  let rec = null;
  let busy = false;
  const b = h("button", { class: `${cls} voice-btn`, title, type: "button" }, icon("mic"));
  const stop = () => { if (rec) { try { rec.stop(); } catch {} } };
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (native()) {
      const app = window.leonote;
      const sp = speechOf((app.settings.speech || {}).provider || "local");
      if (sp.id !== "windows") {
        // a cloud model: record until the next click (or a minute), then send the clip up
        if (busy) { if (b._stop) b._stop(); return; }
        busy = true;
        b.classList.add("is-on"); b.classList.remove("is-off");
        b.title = "Recording… click again when done";
        const until = new Promise((resolve) => { b._stop = resolve; });
        // Whisper here: what is missing of it is offered first (nothing is fetched without that click)
        (sp.id === "local" ? import("./tools.js").then((m) => m.setupSpeech(app)) : Promise.resolve(true))
          .then((ok) => { if (!ok) throw new Error("Whisper is not installed - Settings › Optional modules."); return record(until); })
          .then(({ blob, mime }) => { b.title = "Transcribing…"; b.classList.add("is-wait"); return transcribe(app, blob, mime); })
          .then((said) => { if (said) onText(said); })
          .catch((err) => fail(err && err.name === "NotAllowedError" ? "The microphone was refused by Windows - check Privacy › Microphone." : String((err && err.message) || err)))
          .finally(() => { busy = false; b._stop = null; b.classList.remove("is-on", "is-wait"); if (!b.classList.contains("is-off")) b.title = title; });
        return;
      }
      if (busy) return;
      busy = true;
      b.classList.add("is-on"); b.classList.remove("is-off");
      b.title = "Listening… say it, then pause";
      window.leonote.host.voiceListen()
        .then((said) => { if (said) onText(said); })
        .catch((err) => fail(String((err && err.message) || err)))
        .finally(() => { busy = false; b.classList.remove("is-on"); if (!b.classList.contains("is-off")) b.title = title; });
      return;
    }
    if (rec) { stop(); return; }
    try { rec = new Rec(); } catch { rec = null; fail("Voice input could not start here."); return; }
    rec.lang = lang || navigator.language || "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    b.classList.add("is-on");
    b.classList.remove("is-off");
    b.title = "Listening… click to stop";
    rec.onresult = (ev) => { const said = ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : ""; if (said) onText(said); };
    rec.onerror = (ev) => {
      if (ev.error === "no-speech") return;
      if (ev.error === "not-allowed" || ev.error === "audio-capture") fail(ev.error === "not-allowed" ? "The microphone was refused. Click the mic again to be asked once more." : "No microphone was found.");
      else if (ev.error === "network" || ev.error === "service-not-allowed") fail("No speech service behind this window (WebView2 has none). Typing does the same.");
      else if (ev.error !== "aborted") fail(`Voice input failed: ${ev.error}`);
    };
    rec.onend = () => { rec = null; b.classList.remove("is-on"); if (!b.classList.contains("is-off")) b.title = title; };
    try { rec.start(); } catch { rec = null; b.classList.remove("is-on"); }
  });
  // right-click: try again, test the microphone, or go to Windows' own switches for it
  b.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    const open = (u) => (window.leonote && window.leonote.host ? window.leonote.host.openUrl(u) : Promise.reject()).catch(() => toast("Open Settings › Privacy › Microphone by hand.", { ms: 5000 }));
    menu(e.clientX, e.clientY, [
      { header: b.dataset.why ? "Last time: " + b.dataset.why : `Microphone · ${speechOf(((window.leonote || {}).settings || {}).speech && window.leonote.settings.speech.provider).name}` },
      { label: "Speech recognition settings", icon: "settings", run: () => window.leonote && window.leonote.openSettings && window.leonote.openSettings("Speech recognition") },
      { label: "Try again", icon: "mic", run: () => { b.classList.remove("is-off"); delete b.dataset.why; b.title = title; b.click(); } },
      { label: "Test the microphone", icon: "volume", run: async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("No microphone access in this window at all.", { ms: 5000 }); return; }
        try {
          const st = await navigator.mediaDevices.getUserMedia({ audio: true });
          const name = (st.getAudioTracks()[0] || {}).label || "a microphone";
          st.getTracks().forEach((t) => t.stop());
          const n = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput").length;
          toast(`Microphone works: ${name}${n > 1 ? ` (${n} available - Windows picks the default one)` : ""}. Speech itself needs a speech service; none means typing.`, { ms: 8000 });
        } catch (err) { toast(`The microphone was refused: ${err && err.name === "NotAllowedError" ? "Windows or the browser said no - check Privacy › Microphone and “Let desktop apps access your microphone”" : err && err.message || err}`, { ms: 8000 }); }
      } },
      "sep",
      { label: "Windows: microphone privacy", icon: "settings", run: () => open("ms-settings:privacy-microphone") },
      { label: "Windows: speech (language, online recognition)", icon: "settings", run: () => open("ms-settings:privacy-speech") },
      { label: "Windows: sound devices (pick the mic)", icon: "settings", run: () => open("ms-settings:sound") },
    ]);
  });
  function fail(why) {
    const again = b.classList.contains("is-off") && b.dataset.why === why;
    b.classList.add("is-off");
    b.dataset.why = why;
    b.title = why + " Click to try again.";
    if (!again) toast(why, { ms: 5000 });
  }
  return b;
}
