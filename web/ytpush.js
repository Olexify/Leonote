// A YouTube playlist changed from Leonote: with "Send my changes to YouTube"
// on for an imported playlist, a video taken out of it here is taken out of
// the YouTube playlist, and one added here is added there. Through YouTube's
// own Data API, signed in with the user's own Google app (the one Calendar
// uses) - only playlists of their own channel can be changed.
import { deadline } from "./util.js";
import { makeVerifier, challengeOf, authUrl, tokenRecord, tokenError, tokenStore, revokeGoogle, SIGNIN_NOTE } from "./ytaccount.js";
import { confirmDialog } from "./ui.js";
import { ytIdOf } from "./playqueue.js";

const API = "https://www.googleapis.com/youtube/v3";
export const SCOPE = "https://www.googleapis.com/auth/youtube";

/** The list= id of a playlist link (or the bare id). */
export const listIdOf = (link) => (/[?&]list=([\w-]+)/.exec(link || "") || [])[1] || (/^[\w-]{13,}$/.test(link || "") ? link : "");

export function createYtPush(app, M) {
  const store = tokenStore(app, "youtubeAuth", () => app.bus.emit("ytpush"));
  const S = () => store.S() || {};
  const save = store.save;
  const creds = () => ({ clientId: (app.settings.googleClientId || "").trim(), clientSecret: (app.settings.googleClientSecret || "").trim() });
  // a sign-in Google ended (a test app's 7 days, a revoke) is signed out: Settings offers Sign in again, the API key is
  // used again where one is set, and nothing retries it every hour
  const connected = () => !!((S().refresh || S().sealed) && !S().expired);

  async function token(form) {
    const { clientId, clientSecret } = creds();
    const r = await app.host.googleToken({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), ...form }, "youtube");
    if (r && r.body && r.body.error === "invalid_grant" && form.grant_type === "refresh_token") save({ expired: true });
    if (!r || r.status !== 200 || !r.body) throw new Error(tokenError(r ? r.status : 0, r && r.body));
    return r.body;
  }
  let refreshing = null;
  async function bearer() {
    const g = S();
    if (!g.refresh && !g.sealed) throw new Error("YouTube is not signed in (Settings › Player › YouTube account).");
    if (g.expired) throw new Error("The YouTube sign-in has ended - sign in again in Settings › Player › YouTube account.");
    if (store.live()) return store.live();
    if (!refreshing) refreshing = token({ grant_type: "refresh_token", refresh_token: g.refresh }).then((j) => { save(tokenRecord(j, g)); return store.live(); }).finally(() => { refreshing = null; });
    return refreshing;
  }
  const said = (status, json) => {
    const err = (json && json.error) || {};
    const why = ((err.errors || [])[0] || {}).reason || "";
    if (/accessNotConfigured|has not been used|is disabled/i.test(err.message || "")) return "Turn on the YouTube Data API v3 for your Google project, then try again.";
    if (why === "quotaExceeded") return "Your Google app's YouTube allowance for today is used up - it can go on tomorrow.";
    if (/rateLimitExceeded/.test(why)) return "YouTube says slow down - it goes on later.";
    if (status === 403 || why === "playlistItemsNotAccessible" || why === "forbidden") return "YouTube refused: only playlists of your own channel can be changed from here.";
    if (status === 404 || why === "playlistNotFound") return "YouTube has no such playlist (deleted, or someone else's private one).";
    return err.message ? `YouTube said: ${err.message}` : `YouTube answered with ${status}.`;
  };
  async function api(method, path, { params, body, retry = true } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const res = await fetch(url, { method, signal: deadline(20000), headers: { Authorization: `Bearer ${await bearer()}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && retry) { save({ expires: 0 }); return api(method, path, { params, body, retry: false }); }
    if (res.status === 204) return null;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(said(res.status, json)), { status: res.status, reason: (((json && json.error && json.error.errors) || [])[0] || {}).reason || "" });
    return json;
  }

  async function connect() {
    if (!creds().clientId) throw new Error("Set up your Google app first: Settings › Calendar › Google app (the YouTube Data API v3 turned on for it).");
    const verifier = makeVerifier(), state = makeVerifier(24);
    const { port, redirect } = await app.host.oauthListen(state);
    app.toast(SIGNIN_NOTE, { ms: 9000 });
    app.host.openUrl(authUrl({ clientId: creds().clientId, redirect, challenge: await challengeOf(verifier), state, scopes: SCOPE }));
    const r = await app.host.oauthWait(port, 240000);
    if (r.error) throw new Error(r.error === "access_denied" ? "Sign-in was refused." : `Sign-in failed: ${r.error}`);
    if (r.state !== state) throw new Error("The sign-in answer did not belong to this request.");
    save({ ...tokenRecord(await token({ grant_type: "authorization_code", code: r.code, redirect_uri: redirect, code_verifier: verifier })), expired: false });
    try { const me = await api("GET", "/channels", { params: { part: "snippet", mine: "true" } }); save({ who: (((me && me.items) || [])[0] || {}).snippet?.title || "" }); } catch {}
  }
  async function disconnect() {
    await revokeGoogle(app, "youtube", S());
    app.setSetting("youtubeAuth", {}); app.setSetting("ytPushQueue", []); app.host.aiKeySet("google-youtube", "").catch(() => {}); app.bus.emit("ytpush");
    // playlists read through this sign-in: offered for removal here, YouTube itself left as it is
    const mine = (M && M.playlists ? M.playlists.all() : []).filter((p) => p.ytSignedIn);
    if (mine.length && await confirmDialog(`Also remove the ${mine.length === 1 ? "playlist" : mine.length + " playlists"} read through this sign-in?`,
      "Only Leonote's copies go. Nothing on YouTube is touched.", { ok: "Remove" })) for (const p of mine) M.playlists.remove(p.id);
  }

  // Changes wait in a queue kept in settings, one after another in the order
  // they were made: YouTube allows about 200 a day to one Google app, so a
  // big trim goes on the next day by itself instead of stopping halfway.
  const pending = () => (Array.isArray(app.settings.ytPushQueue) ? app.settings.ytPushQueue : []);
  // "send my changes to YouTube" is said on this computer: a playlist's own ytPush flag travels with a synced vault,
  // so it counts only where this computer's list (app.json) also holds that YouTube playlist
  const onHere = () => (Array.isArray(app.settings.ytPushLists) ? app.settings.ytPushLists : []);
  const pushOn = (pl) => !!(pl && pl.ytPush && onHere().includes(listIdOf(pl.ytList)));
  const setPushOn = (pl, on) => { const id = listIdOf(pl.ytList); if (id) app.setSetting("ytPushLists", on ? [...new Set([...onHere(), id])] : onHere().filter((x) => x !== id)); };
  let draining = false, pausedTill = 0;
  async function drain() {
    if (draining || !connected() || Date.now() < pausedTill) return;
    draining = true;
    let done = 0, refused = 0, lastRefusal = "";
    // only a playlist this computer is told to send changes to: anything else in the queue is not carried out
    const allowed = new Set(((M && M.playlists ? M.playlists.all() : []).filter(pushOn)).map((p) => listIdOf(p.ytList)).filter(Boolean));
    try {
      while (pending().length) {
        const op = pending()[0];
        if (!op || !allowed.has(op.list) || !/^[\w-]{6,20}$/.test(op.v || "")) { app.setSetting("ytPushQueue", pending().slice(1)); continue; }
        try {
          // the entries of that video in the list (it can be in twice)
          const j = await api("GET", "/playlistItems", { params: { part: "id", playlistId: op.list, videoId: op.v, maxResults: "50" } });
          const there = (j && j.items) || [];
          if (op.del) { for (const it of there) await api("DELETE", "/playlistItems", { params: { id: it.id } }); }
          // already in it (an add sent before, its answer lost): not added twice
          else if (!there.length) await api("POST", "/playlistItems", { params: { part: "snippet" }, body: { snippet: { playlistId: op.list, resourceId: { kind: "youtube#video", videoId: op.v } } } });
          done++;
        } catch (e) {
          // refused for good (not the user's playlist, gone, a bad video): dropped and said once - it held up the rest
          // only what belongs to this one change: a refusal of the whole account (the API off, a missing right, the
          // day's limit) waits like the rest instead of letting every change go
          const forGood = /^(playlistItemsNotAccessible|playlistNotFound|videoNotFound|forbidden|invalidValue|manualSortRequired|playlistOperationUnsupported)$/.test(e.reason || "") || (e.status === 404 && !e.reason);
          if (!forGood) throw e;
          refused++; lastRefusal = String(e.message || e);
        }
        app.setSetting("ytPushQueue", pending().slice(1));
      }
      if (done) app.toast(`YouTube playlists: ${done} change${done === 1 ? "" : "s"} sent`, { ms: 2600 });
      if (refused) app.toast(`YouTube refused ${refused} change${refused === 1 ? "" : "s"}, so ${refused === 1 ? "it was" : "they were"} let go: ${lastRefusal}`, { kind: "error", ms: 9000 });
    } catch (e) {
      const msg = String(e.message || e);
      // the day's allowance is used up: on again in a few hours; anything else is said once and waits too
      pausedTill = Date.now() + (/allowance/.test(msg) ? 6 : 1) * 3600000;
      app.toast(`${done ? `Sent ${done}, ${pending().length} wait - ` : ""}${msg}${/allowance/.test(msg) ? " The rest go on by themselves." : ""}`, { kind: "error", ms: 9000 });
    } finally { draining = false; }
  }
  function push(pl, added, removed) {
    const list = listIdOf(pl.ytList);
    // queued while a sign-in exists, ended or not: drain() waits until it is renewed, and they go then
    if (!list || !(S().refresh || S().sealed) || !pushOn(pl)) return;
    app.setSetting("ytPushQueue", [...pending(), ...removed.map((k) => ({ list, v: ytIdOf(k), del: 1 })), ...added.map((k) => ({ list, v: ytIdOf(k) }))]);
    drain();
  }
  M.playlists.pushTo = push;
  setTimeout(drain, 90000);
  setInterval(drain, 3600000);
  return { api, connected, connect, disconnect, pushOn, setPushOn, who: () => S().who || "", waiting: () => pending().length };
}
