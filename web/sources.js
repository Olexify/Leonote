import { deadline } from "./util.js";
// Search sources the user sets up themselves. Nothing is configured here:
// Leonote ships with no sites, no keys and no network calls - a source only
// exists because someone typed it in, and it is only used while they search.
//
// Two kinds, so more can follow without changing what is stored:
//   "link"        a search page opened in the real browser (nothing is
//                 scraped, embedded or reformatted - just a link out)
//   "youtube-api" the official YouTube Data API with the user's own key
//
// The API answers stay in memory for the session. Results keep their titles,
// channel names and a link to the original, as those APIs require.

export const SOURCE_KINDS = [
  ["link", "Opens the site's own search page in your browser"],
  ["youtube-api", "YouTube Data API (your own key) - results appear here"],
];

let seq = 0;
const uid = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A stored source record, or { error } when the form is not usable yet. */
export function makeSource(input = {}) {
  const name = String(input.name || "").trim();
  const kind = SOURCE_KINDS.some(([k]) => k === input.kind) ? input.kind : "link";
  const url = String(input.url || "").trim();
  if (!name) return { error: "Give the source a name." };
  if (kind === "link") {
    if (!/^https?:\/\//i.test(url)) return { error: "The search address must start with http:// or https://" };
    if (!url.includes("{q}")) return { error: "Put {q} where the search words belong, for example https://example.com/search?q={q}" };
  }
  if (kind === "youtube-api" && !String(input.apiKey || "").trim()) return { error: "Paste your own YouTube Data API key, or pick the link kind instead." };
  return {
    id: input.id || uid(),
    name,
    kind,
    url: kind === "link" ? url : "",
    color: String(input.color || "").trim() || "#7a7a86",
    apiKey: kind === "youtube-api" ? String(input.apiKey || "").trim() : "",
    addedAt: input.addedAt || Date.now(),
  };
}

/** The address to open in the browser for `query` (null when it makes no sense). */
export function searchUrl(src, query) {
  if (!src || src.kind !== "link" || !src.url.includes("{q}")) return null;
  const q = String(query || "").trim();
  if (!q) return null;
  return src.url.replace(/\{q\}/g, encodeURIComponent(q));
}

/** The site a link source belongs to, for the row's subtitle. */
export function sourceHost(src) {
  try { return new URL((src.url || "").replace("{q}", "x")).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/* ── the YouTube Data API (the user's own key) ─────────────────────────── */

const API = "https://www.googleapis.com/youtube/v3";

/** "PT4M13S" -> 253. */
export function parseIsoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(s || ""));
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + Math.round(+m[4] || 0);
}

/** What a search answer means for the Player (ignores anything malformed). */
export function mapSearch(json) {
  const items = (json && json.items) || [];
  return items
    .map((it) => {
      const id = it && it.id && (it.id.videoId || it.id);
      const sn = (it && it.snippet) || {};
      if (!id || typeof id !== "string" || !sn.title) return null;
      const th = (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default)) || {};
      return { id, title: decodeEntities(sn.title), channel: decodeEntities(sn.channelTitle || ""), thumb: th.url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, published: sn.publishedAt || "" };
    })
    .filter(Boolean);
}

/** id -> seconds, from a `videos?part=contentDetails` answer. */
export function mapDurations(json) {
  const out = new Map();
  for (const it of (json && json.items) || []) {
    if (it && it.id && it.contentDetails) out.set(it.id, parseIsoDuration(it.contentDetails.duration));
  }
  return out;
}

/** Tracks in a playlist answer, plus the page token to continue with. */
export function mapPlaylistItems(json) {
  const items = [];
  for (const it of (json && json.items) || []) {
    const sn = (it && it.snippet) || {};
    const id = (sn.resourceId && sn.resourceId.videoId) || (it.contentDetails && it.contentDetails.videoId);
    if (!id || !sn.title) continue;
    const title = decodeEntities(sn.title);
    if (title === "Deleted video" || title === "Private video") continue;
    items.push({ id, title, artists: [decodeEntities(sn.videoOwnerChannelTitle || sn.channelTitle || "")].filter(Boolean), url: `https://www.youtube.com/watch?v=${id}` });
  }
  return { items, next: (json && json.nextPageToken) || "" };
}

// API answers carry HTML entities in titles
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&(#\d+|#x[0-9a-f]+|amp|quot|#39|apos|lt|gt|nbsp);/gi, (m, e) => {
      const l = e.toLowerCase();
      if (l === "amp") return "&";
      if (l === "quot") return '"';
      if (l === "#39" || l === "apos") return "'";
      if (l === "lt") return "<";
      if (l === "gt") return ">";
      if (l === "nbsp") return " ";
      if (l[0] === "#") return String.fromCodePoint(l[1] === "x" ? parseInt(l.slice(2), 16) : +l.slice(1));
      return m;
    });
}

/** A plain sentence for an API failure, so a quota is not a stack trace. */
export function apiErrorMessage(status, body) {
  const reason = (((body || {}).error || {}).errors || [{}])[0].reason || "";
  const msg = ((body || {}).error || {}).message || "";
  if (status === 403 && /quota/i.test(reason + msg)) return "That key has used up today's YouTube quota. It resets at midnight Pacific time.";
  if (status === 403 && /keyInvalid|forbidden|blocked/i.test(reason)) return "YouTube refused that key. Check it is a Data API v3 key with no referrer restrictions.";
  if (status === 400 && /keyInvalid|badRequest/i.test(reason + msg)) return "That does not look like a valid API key.";
  if (status === 404) return "YouTube has nothing at that address (a private or removed playlist?).";
  if (status === 0) return "No answer from YouTube - is this computer offline?";
  return msg ? `YouTube said: ${msg}` : `YouTube answered with ${status}.`;
}

async function call(path, params, { signal } = {}) {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  let res;
  try {
    res = await fetch(url, { signal: deadline(20000, signal) });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new Error(apiErrorMessage(0, null));
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(apiErrorMessage(res.status, body));
  return body;
}

/** One Data API call: with the user's key, or through `auth(path, params)` when they signed in instead. */
const ask = (auth, path, params, opts) => (typeof auth === "function" ? auth(path, params) : call(path, { ...params, key: auth }, opts));

/** Search videos with the user's key or sign-in; durations come from a second call. */
export async function ytSearch(auth, query, { signal, max = 20 } = {}) {
  const found = mapSearch(await ask(auth, "search", { part: "snippet", type: "video", maxResults: Math.min(50, max), q: query }, { signal }));
  if (!found.length) return found;
  try {
    const d = mapDurations(await ask(auth, "videos", { part: "contentDetails", id: found.map((f) => f.id).join(",") }, { signal }));
    for (const f of found) f.duration = d.get(f.id) || 0;
  } catch { /* titles are enough; durations are a nicety */ }
  return found;
}

/** Every track of a public YouTube playlist (the official way in). */
// ponytail: 200 pages (10 000 videos) is the ceiling, as for the page reader; a bigger list stops there and says so
export async function ytPlaylist(auth, listId, { signal, maxPages = 200 } = {}) {
  const tracks = [];
  let page = "";
  let truncated = false;
  for (let i = 0; ; i++) {
    if (i >= maxPages) { truncated = true; break; }
    const json = await ask(auth, "playlistItems", { part: "snippet,contentDetails", maxResults: 50, playlistId: listId, ...(page ? { pageToken: page } : {}) }, { signal });
    const { items, next } = mapPlaylistItems(json);
    if (items.length) {
      try {
        const d = mapDurations(await ask(auth, "videos", { part: "contentDetails", id: items.map((x) => x.id).join(",") }, { signal }));
        for (const x of items) x.secs = d.get(x.id) || 0;
      } catch { /* titles are enough; lengths are a nicety */ }
    }
    tracks.push(...items);
    if (!next) break;
    page = next;
  }
  let name = "";
  try {
    const meta = await ask(auth, "playlists", { part: "snippet", id: listId }, { signal });
    name = decodeEntities(((meta.items || [])[0] || {}).snippet?.title || "");
  } catch { /* the list still imports without its name */ }
  return { name: name || "YouTube playlist", items: tracks, truncated };
}

/** The list id in a YouTube playlist link. */
export function playlistId(link) {
  const s = String(link || "").trim();
  if (/^(PL|OL|UU|FL|RD|LL)[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return (/[?&]list=([\w-]+)/.exec(s) || [])[1] || "";
}

/* YouTube is read through the Data API, with the user's own sign-in or key. Everything that reads a list or finds a song comes here. */
function ytAuth(app) {
  if (app.ytPush && app.ytPush.connected()) return (path, params) => app.ytPush.api("GET", `/${path}`, { params });
  const key = String(app.settings.ytApiKey || "").trim();
  if (key) return key;
  throw new Error("Reading YouTube playlists and finding songs needs your own YouTube sign-in or key: Settings › Player › YouTube account.");
}
/** A playlist link read: { name, items: [{ id, title, secs? }], truncated }. */
export async function readYtList(app, link) {
  const auth = ytAuth(app);
  const id = playlistId(link);
  if (!id) throw new Error("That is not a YouTube playlist link");
  return ytPlaylist(auth, id);
}
/** The first video for some words: { id, title }, or null. */
export async function findYtVideo(app, query) {
  return (await ytSearch(ytAuth(app), String(query).trim().slice(0, 200), { max: 1 }))[0] || null;
}

/* ── adding a site by pasting its address ─────────────────────────────── */

// Search addresses for sites people often ask for. Nothing here is enabled
// or contacted on its own: it only saves typing when someone pastes a domain
// and asks for it to become a source, and the address stays editable.
const KNOWN = {
  "youtube.com": "https://www.youtube.com/results?search_query={q}",
  "odysee.com": "https://odysee.com/$/search?q={q}",
  "bandcamp.com": "https://bandcamp.com/search?q={q}",
  "soundcloud.com": "https://soundcloud.com/search?q={q}",
  "archive.org": "https://archive.org/search?query={q}",
  "vimeo.com": "https://vimeo.com/search?q={q}",
  "dailymotion.com": "https://www.dailymotion.com/search/{q}",
  "mixcloud.com": "https://www.mixcloud.com/search/?q={q}",
  "rumble.com": "https://rumble.com/search/video?q={q}",
  "peertube.tv": "https://peertube.tv/search?search={q}",
  "nicovideo.jp": "https://www.nicovideo.jp/search/{q}",
  "discogs.com": "https://www.discogs.com/search/?q={q}",
  "musicbrainz.org": "https://musicbrainz.org/search?query={q}&type=recording",
  "last.fm": "https://www.last.fm/search?q={q}",
  // research, for the same reason: typing one of these should not mean
  // hunting for the right query parameter
  "duckduckgo.com": "https://duckduckgo.com/?q={q}",
  "google.com": "https://www.google.com/search?q={q}",
  "bing.com": "https://www.bing.com/search?q={q}",
  "startpage.com": "https://www.startpage.com/sp/search?query={q}",
  "ecosia.org": "https://www.ecosia.org/search?q={q}",
  "brave.com": "https://search.brave.com/search?q={q}",
  "search.brave.com": "https://search.brave.com/search?q={q}",
  "mojeek.com": "https://www.mojeek.com/search?q={q}",
  "marginalia.nu": "https://search.marginalia.nu/search?query={q}",
  "wikipedia.org": "https://en.wikipedia.org/w/index.php?search={q}",
  "scholar.google.com": "https://scholar.google.com/scholar?q={q}",
  "arxiv.org": "https://arxiv.org/abs/{q}",
  "semanticscholar.org": "https://www.semanticscholar.org/search?q={q}",
  "pubmed.ncbi.nlm.nih.gov": "https://pubmed.ncbi.nlm.nih.gov/?term={q}",
  "github.com": "https://github.com/search?q={q}",
  "stackoverflow.com": "https://stackoverflow.com/search?q={q}",
  "reddit.com": "https://www.reddit.com/search/?q={q}",
  "news.ycombinator.com": "https://hn.algolia.com/?q={q}",
  "perplexity.ai": "https://www.perplexity.ai/search?q={q}",
  "wolframalpha.com": "https://www.wolframalpha.com/input?i={q}",
};

/** Is this text just a site, rather than a link to something? */
export function bareDomain(text) {
  const t = String(text || "").trim();
  if (!t || /\s/.test(t)) return null;
  const m = /^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/[^?#]*)?\/?(?:[?#].*)?$/i.exec(t);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/^www\./, "");
  // a path that points at something (a video, a file) is not a bare site
  if (m[2] && m[2].replace(/\/+$/, "").length > 1) return null;
  const base = host.split(".").slice(-2).join(".");
  return { host, base, youtube: /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/.test(host) || base === "youtube.com" };
}

/** A search address to start from for `host` (the user can edit it after). */
export function guessTemplate(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const base = h.split(".").slice(-2).join(".");
  return KNOWN[h] || KNOWN[base] || `https://${h}/search?q={q}`;
}

/** Where a person gets their own YouTube key. */
export const YT_KEY_PAGE = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
