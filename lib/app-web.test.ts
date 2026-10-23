import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The QoreTrader web app's cross-origin path (lib/app-web.ts): CORS + preflight only for its own origin, the session token in the
// login answer only when it asks from that origin, and the bearer token accepted wherever the cookie is. Real Redis sessions
// (REDIS_URL, e.g. db 11); the credential check and the DB-backed login bookkeeping are stubbed, the session itself is minted for real.
const ctx = { cookie: "", authorization: "", brokerId: "" };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "vyx_trade_session" && ctx.cookie ? { name, value: ctx.cookie } : undefined) }),
  headers: async () => new Headers({ "x-broker-id": ctx.brokerId, ...(ctx.authorization ? { authorization: ctx.authorization } : {}) }),
}));
vi.mock("@/lib/client-builds", () => ({ checkClientBuild: async () => ({ ok: true, buildId: null }), clientBuildErrorMessage: () => "", prefetchClientBuild: () => null }));
vi.mock("@/lib/cookie-domain", () => ({ cookieScopeDomain: async () => undefined }));
vi.mock("@/lib/demo-hook", () => ({ demoSessionHook: async () => true }));
vi.mock("@/lib/schema-guard-edge", () => ({ createSchemaGate: () => ({ isBehind: async () => false }), schemaGuardExempt: () => true, UPDATING_BODY: { error: "updating" } }));
vi.mock("@/lib/account-auth", async (orig) => {
  const real = await orig<typeof import("@/lib/account-auth")>();
  return {
    ...real,
    authenticateAccountDetailed: async (brokerId: string, accountNumber: string, password: string) =>
      password === "right"
        ? { kind: "ok", account: { id: `acc-${accountNumber}`, brokerId, accountNumber, accountMode: "DEMO", twoFactorEnabled: false } }
        : { kind: "invalid" },
    completeAccountLogin: async (account: { id: string; brokerId: string }) => real.createAccountSession({ accountId: account.id, brokerId: account.brokerId } as never),
  };
});

import { appWebCorsHeaders, bearerToken, isAppWebOrigin, wantsSessionToken } from "@/lib/app-web";
import { getAccountSession } from "@/lib/account-auth";
import { getRedis } from "@/lib/redis";
import { middleware } from "@/middleware";
import { POST as login } from "@/app/api/trade/login/route";
import { POST as logout } from "@/app/api/trade/logout/route";

const APP = "https://app.qoretrader.com";
const EVIL = "https://evil.example";
const BROKER = "broker-appweb-test";

let ready = false;
beforeAll(async () => {
  try { await getRedis().ping(); ready = true; } catch { console.warn("app-web.test.ts: Redis unreachable, skipping the session tests"); }
});
afterAll(async () => { if (ready) await getRedis().quit(); });

function loginReq(origin: string | null, transport: boolean, accountNumber = String(Date.now()), password = "right") {
  return new NextRequest("https://futurix.vyxtrader.com/api/trade/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-broker-id": BROKER, ...(origin ? { origin } : {}), ...(transport ? { "x-session-transport": "header" } : {}) },
    body: JSON.stringify({ accountNumber, password }),
  });
}

describe("app-web helpers", () => {
  it("only the configured origin, exactly", () => {
    expect(isAppWebOrigin(APP)).toBe(true);
    for (const o of [EVIL, "http://app.qoretrader.com", "https://app.qoretrader.com.evil.example", "https://xapp.qoretrader.com", "", null]) expect(isAppWebOrigin(o)).toBe(false);
  });
  it("CORS only on the web app's routes, never credentials", () => {
    const h = appWebCorsHeaders(APP, "/api/trade/orders")!;
    expect(h["Access-Control-Allow-Origin"]).toBe(APP);
    expect(h["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(h).not.toHaveProperty("Access-Control-Allow-Credentials");
    expect(appWebCorsHeaders(APP, "/api/public/brokers")).not.toBeNull();
    // execution latency Phase 1: the web app reads the VPS execution endpoint's liveness before sending orders there
    expect(appWebCorsHeaders(APP, "/api/health")).not.toBeNull();
    expect(appWebCorsHeaders(EVIL, "/api/health")).toBeNull();
    expect(appWebCorsHeaders(APP, "/api/manage/accounts")).toBeNull();
    expect(appWebCorsHeaders(APP, "/api/admin/brokers")).toBeNull();
    expect(appWebCorsHeaders(EVIL, "/api/trade/orders")).toBeNull();
  });
  it("bearer parsing", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    for (const v of ["abc123", "Basic abc", "Bearer", "Bearer a b", "", null]) expect(bearerToken(v)).toBeNull();
  });
  it("the token in the body needs both the header and the origin", () => {
    expect(wantsSessionToken(new Headers({ origin: APP, "x-session-transport": "header" }))).toBe(true);
    expect(wantsSessionToken(new Headers({ origin: EVIL, "x-session-transport": "header" }))).toBe(false);
    expect(wantsSessionToken(new Headers({ "x-session-transport": "header" }))).toBe(false);
    expect(wantsSessionToken(new Headers({ origin: APP }))).toBe(false);
  });
});

describe("middleware CORS", () => {
  it("answers the web app's preflight before any broker lookup", async () => {
    const r = await middleware(new NextRequest("https://futurix.vyxtrader.com/api/trade/login", { method: "OPTIONS", headers: { origin: APP, "access-control-request-method": "POST" } }));
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(APP);
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
  });
  it("adds the headers to the web app's answers, not to anyone else's", async () => {
    const ok = await middleware(new NextRequest("https://www.localhost/api/public/brokers", { headers: { origin: APP } }));
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP);
    const other = await middleware(new NextRequest("https://www.localhost/api/public/brokers", { headers: { origin: EVIL } }));
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const page = await middleware(new NextRequest("https://www.localhost/", { headers: { origin: APP } }));
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("session token transport", () => {
  it("login returns the token only to the web app that asks", async () => {
    if (!ready) return;
    const plain = await (await login(loginReq(null, false))).json();
    expect(plain).not.toHaveProperty("sessionToken");
    const evil = await (await login(loginReq(EVIL, true))).json();
    expect(evil).not.toHaveProperty("sessionToken");
    const unasked = await (await login(loginReq(APP, false))).json();
    expect(unasked).not.toHaveProperty("sessionToken");
    const r = await login(loginReq(APP, true));
    const web = await r.json();
    expect(typeof web.sessionToken).toBe("string");
    expect(web.sessionToken.length).toBeGreaterThan(32);
    // the cookie is still set exactly as before (same token)
    expect(r.cookies.get("vyx_trade_session")?.value).toBe(web.sessionToken);
    const bad = await login(loginReq(APP, true, String(Date.now()), "wrong"));
    expect(bad.status).toBe(401);
    expect(await bad.json()).not.toHaveProperty("sessionToken");
  });

  it("the bearer token is a session, bound to its broker, ended by logout", async () => {
    if (!ready) return;
    const { sessionToken } = await (await login(loginReq(APP, true, "880001"))).json();
    Object.assign(ctx, { cookie: "", authorization: `Bearer ${sessionToken}`, brokerId: BROKER });
    expect((await getAccountSession())?.accountId).toBe("acc-880001");
    // another broker's host never accepts it
    ctx.brokerId = "some-other-broker";
    expect(await getAccountSession()).toBeNull();
    ctx.brokerId = BROKER;
    // a made-up token is nothing
    ctx.authorization = "Bearer " + "0".repeat(64);
    expect(await getAccountSession()).toBeNull();
    // the cookie still wins when both are present
    const { sessionToken: other } = await (await login(loginReq(APP, true, "880002"))).json();
    Object.assign(ctx, { cookie: other, authorization: `Bearer ${sessionToken}` });
    expect((await getAccountSession())?.accountId).toBe("acc-880002");
    // logout by bearer revokes it for good
    const out = await logout(new NextRequest("https://futurix.vyxtrader.com/api/trade/logout", { method: "POST", headers: { authorization: `Bearer ${sessionToken}`, origin: APP } }));
    expect(out.status).toBe(200);
    Object.assign(ctx, { cookie: "", authorization: `Bearer ${sessionToken}` });
    expect(await getAccountSession()).toBeNull();
  });
});
