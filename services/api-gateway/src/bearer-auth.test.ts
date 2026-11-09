import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerToken, sessionTokenFrom } from "./auth.js";

// The PWA / mobile build (app.qoretrader.com) is one page origin for every broker, so it can never carry
// a broker's session cookie and sends `Authorization: Bearer <session token>` instead -- the same opaque
// token, resolved from the same Redis key. These tests pin the parsing and, more importantly, the
// PRECEDENCE: a request that carries both must resolve from the cookie, never from a header a caller
// controls more freely.

test("a Bearer token is read, case-insensitively, and trimmed", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer abc123"), "abc123");
  assert.equal(bearerToken("BEARER abc123"), "abc123");
  assert.equal(bearerToken("Bearer    abc123   "), "abc123");
  assert.equal(bearerToken("  Bearer abc123"), "abc123");
});

test("anything that is not a non-empty Bearer token is null", () => {
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(""), null);
  assert.equal(bearerToken("Bearer"), null);
  assert.equal(bearerToken("Bearer "), null);
  assert.equal(bearerToken("Bearer    "), null);
  // a different scheme is not ours to interpret
  assert.equal(bearerToken("Basic abc123"), null);
  assert.equal(bearerToken("Token abc123"), null);
  // the token itself is opaque: no shape is assumed beyond non-empty
  assert.equal(bearerToken("Bearer a.b-c_d"), "a.b-c_d");
});

test("the cookie wins when both are present, so a cookie caller can never be downgraded", () => {
  const both = { cookie: "vyx_trade_session=from-cookie", authorization: "Bearer from-header" };
  assert.equal(sessionTokenFrom(both), "from-cookie");
});

test("the Bearer header is used only when no session cookie came", () => {
  assert.equal(sessionTokenFrom({ authorization: "Bearer only-header" }), "only-header");
  // other cookies present, but not ours
  assert.equal(
    sessionTokenFrom({ cookie: "theme=dark; other=1", authorization: "Bearer only-header" }),
    "only-header"
  );
  // the cookie is present but empty: fall through rather than resolve to an empty token
  assert.equal(sessionTokenFrom({ cookie: "vyx_trade_session=", authorization: "Bearer only-header" }), "only-header");
});

test("no cookie and no Bearer is no token at all", () => {
  assert.equal(sessionTokenFrom({}), null);
  assert.equal(sessionTokenFrom({ cookie: "theme=dark" }), null);
  assert.equal(sessionTokenFrom({ authorization: "Basic nope" }), null);
  assert.equal(sessionTokenFrom({ cookie: "", authorization: "" }), null);
});

test("the cookie path is unchanged: a session cookie resolves exactly as before", () => {
  assert.equal(sessionTokenFrom({ cookie: "vyx_trade_session=tok" }), "tok");
  // url-encoded values keep being decoded, as readCookie always did
  assert.equal(sessionTokenFrom({ cookie: "vyx_trade_session=a%2Bb" }), "a+b");
  // ours among several
  assert.equal(sessionTokenFrom({ cookie: "a=1; vyx_trade_session=tok; b=2" }), "tok");
});
