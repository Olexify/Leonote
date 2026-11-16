// Speech recognition: which ears the mic uses. Windows' own recogniser
// (free, no key), Whisper on this computer (free, private, an optional module), or a cloud model - each provider with a fast-and-cheap
// model and a most-accurate one. The page records the clip (MediaRecorder,
// opus in webm); Rust sends it up (speech_transcribe) with the sealed key.

export const SPEECH = [
  { id: "windows", name: "Windows", blurb: "Built in, free, no key. Needs a speech language installed and, for dictation, online recognition allowed in Privacy › Speech.", keyId: "", models: {} },
  { id: "local", name: "This computer · Whisper", blurb: "Free, no key, private: Whisper on this computer hears the clip - nothing you say leaves it. An optional module (Whisper and ffmpeg, about 250 MB), offered on the first click.", keyId: "", models: {} },
  { id: "groq", name: "Groq · Whisper", base: "https://api.groq.com/openai/v1", keyId: "speech-groq", keyHint: "console.groq.com › API keys - a free tier, very fast",
    models: { fast: ["whisper-large-v3-turbo", "Whisper large v3 turbo - $0.04/h, near-instant"], best: ["whisper-large-v3", "Whisper large v3 - $0.11/h, the most accurate Whisper"] } },
  { id: "openai", name: "OpenAI", base: "https://api.openai.com/v1", keyId: "speech-openai", keyHint: "platform.openai.com › API keys",
    models: { fast: ["gpt-4o-mini-transcribe", "GPT-4o mini transcribe - $0.18/h"], best: ["gpt-4o-transcribe", "GPT-4o transcribe - $0.36/h, best on noisy or accented speech"] } },
  { id: "mistral", name: "Mistral · Voxtral", base: "https://api.mistral.ai/v1", keyId: "speech-mistral", keyHint: "console.mistral.ai › API keys",
    models: { fast: ["voxtral-mini-latest", "Voxtral Mini - $0.12/h"], best: ["voxtral-mini-latest", "Voxtral Mini - the one model, strong on European languages"] } },
];
export const speechOf = (id) => SPEECH.find((s) => s.id === id) || SPEECH[0];
/** The model for a provider and tier. */
export const modelFor = (sp, tier) => (sp.models[tier === "best" ? "best" : "fast"] || sp.models.fast || ["", ""])[0];

/** A clip recorded from the microphone until `until` resolves (a click, a timeout). Returns { blob, mime }. */
export async function record(until, { maxMs = 60000 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start(250);
  const timer = setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, maxMs);
  await until;
  clearTimeout(timer);
  if (rec.state !== "inactive") rec.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());
  return { blob: new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }), mime: rec.mimeType || mime || "audio/webm" };
}

const b64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = reject; r.readAsDataURL(blob); });

/** The clip as words, through the provider chosen in settings. */
export async function transcribe(app, blob, mime) {
  const S = app.settings.speech || {};
  const sp = speechOf(S.provider);
  const model = modelFor(sp, S.tier);
  const lang = (S.lang || "").trim() || null;
  if (sp.id === "local") { const r = await app.host.speechTranscribe({ base: "local", model: "", keyIds: [], audio: await b64(blob), mime, lang, prompt: null }); return r && r.text ? r.text : ""; }
  const ids = [sp.keyId, ...(app.settings.aiProviders || []).filter((p) => p.preset === sp.id).map((p) => p.id)];
  const have = await app.host.aiKeysHave().catch(() => []);
  if (!ids.some((id) => have.includes(id))) { app.openSettings && app.openSettings("Speech recognition"); throw new Error(`No ${sp.name} key yet - paste one under Settings › Speech recognition (${sp.keyHint}).`); }
  const r = await app.host.speechTranscribe({ base: sp.base, model, keyIds: ids, audio: await b64(blob), mime, lang: (S.lang || "").trim() || null, prompt: (S.prompt || "").trim() || null });
  return r && r.text ? r.text : "";
}
