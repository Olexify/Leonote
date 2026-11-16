// Signing in to YouTube with the user's own Google app, to read their own
// playlists and play them here.
//
// OAuth 2.0 with PKCE, the flow for apps that cannot keep a secret: the
// sign-in happens in the user's real browser, a loopback listener on this
// computer catches the redirect, and the token exchange happens here. Nothing
// is scraped and nothing is downloaded: videos play through YouTube's own
// player, as they already do for a pasted link.
//
// Only YouTube, and it asks for the right to manage it (scope auth/youtube): the playlist changes sent from Leonote
// need it. Leonote itself only reads, and adds or removes playlist items it was told to (ytpush.js).

import { deadline } from "./util.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";

export const SCOPES = "https://www.googleapis.com/auth/youtube.readonly";
/** Where a Google app is registered (an OAuth client of type "Desktop app"). */
export const CONSOLE_PAGE = "https://console.cloud.google.com/apis/credentials";
/** What setting up one's own Google app means, said where it is set up and when signing in. */
export const GOOGLE_APP_NOTE = "You create your own Google project and accept Google's terms for it; it is yours and only for you - Leonote has none of its own. While the project is in Testing, Google ends each sign-in after 7 days (sign in again then), and its “Google hasn't verified this app” warning is expected: the app it names is your own.";
export const SIGNIN_NOTE = "Google may say it hasn't verified this app - expected for your own project: Advanced › Go to it. In Testing a sign-in lasts 7 days.";

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A fresh PKCE verifier (43-128 characters of unreserved ASCII). */
export function makeVerifier(len = 64) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const r = new Uint8Array(len);
  crypto.getRandomValues(r);
  return [...r].map((b) => abc[b % abc.length]).join("");
}

export async function challengeOf(verifier) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export function authUrl({ clientId, redirect, challenge, state, scopes = SCOPES }) {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    scope: scopes,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    // a refresh token, so signing in survives closing the app
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH}?${p}`;
}

export function tokenError(status, body) {
  const e = (body && (body.error_description || body.error)) || "";
  if (/invalid_client|unauthorized_client/i.test(e)) return "Google did not recognise that Client ID. Check it is an OAuth client of type “Desktop app”.";
  if (/redirect_uri_mismatch/i.test(e)) return "Google refused the redirect address. A Desktop app client accepts http://127.0.0.1 on any port - make sure the client is that type.";
  if (/invalid_grant/i.test(e)) return "That sign-in has expired. Connect again.";
  if (/access_denied/i.test(e)) return "Sign-in was refused.";
  if (/client_secret/i.test(e)) return "Google wants this app's client secret as well - paste it beside the Client ID.";
  if (status === 0) return "No answer from Google - is this computer offline?";
  return e ? `Google said: ${e}` : `Google answered with ${status}.`;
}

async function form(body) {
  const res = await fetch(TOKEN, { method: "POST", signal: deadline(20000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(tokenError(res.status, json));
  return json;
}

/** Tokens from the code the loopback listener caught. */
export function exchange({ clientId, clientSecret, code, verifier, redirect }) {
  return form({
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
}

export function refresh({ clientId, clientSecret, refreshToken }) {
  return form({
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/**
 * An account's record in the settings (`key`), its short-lived access token kept out: that one lives in memory
 * only, so it never sits in a settings file or the backups made of them - an hour's key to the account. The
 * long-lived refresh token is Windows' (sealed). `save` takes a tokenRecord or any patch; `live()` is the access
 * token while it holds, else "".
 */
export function tokenStore(app, key, after = () => {}) {
  const mem = { access: "", expires: 0 };
  const S = () => app.settings[key] || null;
  const strip = (o) => { const { access, expires, ...rest } = o || {}; return rest; };
  // an access token an earlier version kept in the settings: taken out
  if (S() && ("access" in S() || "expires" in S())) app.setSetting(key, strip(S()));
  const save = (patch) => {
    if ("access" in patch) mem.access = patch.access || "";
    if ("expires" in patch) mem.expires = Number(patch.expires) || 0;
    app.setSetting(key, strip({ ...(S() || {}), ...patch }));
    after();
  };
  const live = () => (mem.access && Date.now() < mem.expires ? mem.access : "");
  return { S, save, live };
}

/** { access, refresh, expires } as a token answer gives it (tokenStore keeps the access token in memory); `sealed`: the refresh token is kept by Windows instead (google_token). */
export const tokenRecord = (json, previous = {}) => ({
  access: json.access_token || previous.access || "",
  refresh: json.sealed ? "" : json.refresh_token || previous.refresh || "",
  sealed: !!json.sealed,
  expires: Date.now() + (json.expires_in ? json.expires_in * 1000 : 3600000) - 60000,
});

/** Signing out: the sign-in revoked at Google (google_token posts it to Google's revoke address), so the token stops
 *  working there and not only here. Best effort: offline or already revoked, the caller still forgets it. */
export async function revokeGoogle(app, slot, record) {
  try { await app.host.googleToken({ grant_type: "revoke", refresh_token: (record && record.refresh) || "" }, slot); } catch {}
}


