// Signing in to YouTube: the pure parts - the authorization URL, the token
// record and the messages a failure turns into. No network here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeVerifier, challengeOf, authUrl, tokenRecord, tokenError, SCOPES } from "../ytaccount.js";

test("the verifier and its challenge follow PKCE", async () => {
  const v = makeVerifier();
  assert.equal(v.length, 64);
  assert.match(v, /^[A-Za-z0-9\-._~]+$/);
  assert.notEqual(makeVerifier(), makeVerifier());
  const c = await challengeOf("abc");
  assert.match(c, /^[A-Za-z0-9\-_]+$/); // base64url, no padding
  assert.equal(c, await challengeOf("abc"));
  assert.notEqual(c, await challengeOf("abd"));
});

test("the sign-in address asks for read-only YouTube and a refresh token", () => {
  const u = new URL(authUrl({ clientId: "cid", redirect: "http://127.0.0.1:5311/callback", challenge: "chal", state: "st" }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = u.searchParams;
  assert.equal(q.get("client_id"), "cid");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:5311/callback");
  assert.equal(q.get("scope"), SCOPES);
  assert.match(SCOPES, /youtube\.readonly$/);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("code_challenge"), "chal");
  assert.equal(q.get("state"), "st");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
});

test("a refresh answer keeps the refresh token it does not resend", () => {
  const first = tokenRecord({ access_token: "a1", refresh_token: "r1", expires_in: 3600 });
  assert.equal(first.access, "a1");
  assert.equal(first.refresh, "r1");
  assert.ok(first.expires > Date.now() + 3500 * 1000 && first.expires <= Date.now() + 3600 * 1000);
  const again = tokenRecord({ access_token: "a2", expires_in: 3600 }, first);
  assert.equal(again.access, "a2");
  assert.equal(again.refresh, "r1", "Google only sends the refresh token once");
});

test("failures say what to do about them", () => {
  assert.match(tokenError(401, { error: "invalid_client" }), /Desktop app/i);
  assert.match(tokenError(400, { error: "redirect_uri_mismatch" }), /127\.0\.0\.1/);
  assert.match(tokenError(400, { error: "invalid_grant" }), /expired/i);
  assert.match(tokenError(400, { error: "access_denied" }), /refused/i);
  assert.match(tokenError(400, { error_description: "client_secret is missing" }), /client secret/i);
  assert.match(tokenError(0, null), /offline/i);
  assert.match(tokenError(503, null), /503/);
});
