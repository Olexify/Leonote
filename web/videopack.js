// Shrinking a video on request, inside the webview: the video plays silently
// once (at normal speed, so a 5-minute clip takes about 5 minutes) while its
// frames are drawn to a smaller canvas and recorded as WebM (VP9 or VP8 with
// Opus). No external tools; the original is kept.

export const VIDEO_PRESETS = {
  small: { label: "Small · 480p", height: 480, bits: 1_800_000 },
  balanced: { label: "Balanced · 720p", height: 720, bits: 4_500_000 },
  high: { label: "High · 1080p", height: 1080, bits: 9_000_000 },
  full: { label: "Best · original size", height: 100000, bits: 14_000_000 },
};

export function canPackVideo() {
  return typeof MediaRecorder !== "undefined" && !!pickType() && typeof HTMLCanvasElement.prototype.captureStream === "function";
}

function pickType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

/** Output size keeping the aspect ratio, never upscaled, even numbers. */
export function fitSize(w, h, maxH) {
  if (!w || !h) return { w: 0, h: 0 };
  const k = Math.min(1, maxH / Math.min(w, h)); // "720p" means the short side
  const even = (n) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(w), h: even(h) };
}

/**
 * Re-encode the video at `url`. onProgress(0..1). Resolves to a Blob, or
 * rejects with "cancelled" when signal aborts.
 */
export function packVideo(url, { preset = "balanced", onProgress, signal } = {}) {
  const P = VIDEO_PRESETS[preset] || VIDEO_PRESETS.balanced;
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.playsInline = true;
    video.src = url;
    let audio = null;
    let rec = null;
    let done = false;
    const chunks = [];
    const stop = (err) => {
      if (done) return;
      done = true;
      try { video.pause(); } catch {}
      if (rec && rec.state !== "inactive") {
        rec.onstop = () => { cleanup(); err ? reject(err) : resolve(new Blob(chunks, { type: "video/webm" })); };
        rec.stop();
      } else { cleanup(); reject(err || new Error("nothing recorded")); }
    };
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
      if (audio) audio.close().catch(() => {});
    };
    if (signal) signal.addEventListener("abort", () => stop(new Error("cancelled")), { once: true });
    video.onerror = () => stop(new Error("this video can't be read here"));
    video.onloadedmetadata = async () => {
      try {
        const { w, h } = fitSize(video.videoWidth, video.videoHeight, P.height);
        if (!w) throw new Error("no video track");
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.imageSmoothingQuality = "high";
        // one captured frame per source frame, so motion stays as smooth as the original
        const stream = canvas.captureStream(0);
        const track = stream.getVideoTracks()[0];
        // the sound goes to the recording only, never to the speakers
        try {
          audio = new AudioContext();
          const src = audio.createMediaElementSource(video);
          const dest = audio.createMediaStreamDestination();
          src.connect(dest);
          for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
        } catch { video.muted = true; }
        rec = new MediaRecorder(stream, { mimeType: pickType(), videoBitsPerSecond: P.bits, audioBitsPerSecond: 128_000 });
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const draw = () => {
          if (done) return;
          ctx.drawImage(video, 0, 0, w, h);
          if (track.requestFrame) track.requestFrame();
          if (onProgress && video.duration) onProgress(Math.min(1, video.currentTime / video.duration));
          if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(draw);
          else setTimeout(draw, 33);
        };
        video.onended = () => { ctx.drawImage(video, 0, 0, w, h); setTimeout(() => stop(), 150); };
        rec.start(1000);
        await video.play();
        draw();
      } catch (e) {
        stop(e instanceof Error ? e : new Error(String(e)));
      }
    };
  });
}
