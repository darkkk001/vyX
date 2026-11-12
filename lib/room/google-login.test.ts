import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateTotpSecret } from "@/lib/totp";
import { checkIdToken, googleAuthUrl, googleLoginEnabledFor, pkceChallenge } from "@/lib/room/google-login";

// "Continue with Google" (owner 2026-11-12): QoreTrader only, behind GOOGLE_LOGIN_ENABLED. A verified Google email that
// matches a client signs that client in (2FA still asked); no match opens /register with the email filled in; Google's
// tokens are never saved. Routes run against a real database; Redis is an in-memory stand-in; Google's token endpoint
// is stubbed.
const store = new Map<string, { v: string; at: number | null }>();
const live = (k: string) => { const e = store.get(k); if (e && e.at !== null && Date.now() >= e.at) { store.delete(k); return undefined; } return e; };
const fake = {
  get: async (k: string) => live(k)?.v ?? null,
  getdel: async (k: string) => { const v = live(k)?.v ?? null; store.delete(k); return v; },
  set: async (k: string, v: string, mode?: string, s?: number) => { const keep = mode === "KEEPTTL" ? live(k)?.at ?? null : null; store.set(k, { v, at: mode === "EX" && s ? Date.now() + s * 1000 : keep }); return "OK"; },
  del: async (...ks: string[]) => { for (const k of ks) store.delete(k); return ks.length; },
  sadd: async () => 1,
  incr: async (k: string) => { const n = Number(live(k)?.v ?? 0) + 1; store.set(k, { v: String(n), at: live(k)?.at ?? null }); return n; },
  expire: async () => 1,
};
vi.mock("@/lib/redis", () => ({ getRedis: () => fake }));
vi.mock("@/lib/totp", async (importActual) => ({ ...(await importActual<typeof import("@/lib/totp")>()), verifyTotp: (_s: string, c: string) => c === "123456" }));
vi.mock("next/headers", () => ({ headers: async () => ({ get: (n: string) => (n === "host" ? "t.local" : null) }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomBroker: vi.fn() }));

const read = (p: string) => readFileSync(p, "utf8");
const s = randomUUID().replace(/-/g, "").slice(0, 10);
const SUB = `gl-${s}`;
const CID = "123-abc.apps.googleusercontent.com";
let dbReachable = false;
let brokerId = "";

beforeAll(async () => {
  process.env.GOOGLE_LOGIN_ENABLED = `othertenant, ${SUB}`;
  process.env.GOOGLE_OAUTH_CLIENT_ID = CID;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("google-login.test.ts: DB unreachable, skipping route cases"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Gl ${s}`, subdomain: SUB } })).id;
  const { roomBroker } = await import("@/lib/room/context");
  vi.mocked(roomBroker).mockResolvedValue({ id: brokerId, name: "Gl", subdomain: SUB, logoUrl: null, primaryColor: null, wordmark: null });
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
const H = { "x-forwarded-proto": "https", host: "t.local" };

/** start -> (Google) -> callback, with Google's answer made from `claims` (the nonce filled in from the start). */
async function trip(claims: Record<string, unknown>, opts: { remember?: boolean; error?: string; dropCookie?: boolean } = {}) {
  const { GET: start } = await import("@/app/api/auth/google/start/route");
  const r = await start(new NextRequest(`https://t.local/api/auth/google/start${opts.remember === false ? "?remember=0" : ""}`, { headers: H }));
  const to = new URL(r.headers.get("location")!);
  const state = to.searchParams.get("state")!;
  const nonce = to.searchParams.get("nonce")!;
  const cookie = r.cookies.get("google_login")?.value ?? "";
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
    sent.push(String(init.body));
    return new Response(JSON.stringify({ access_token: "ya29.ACCESS", id_token: idToken({ iss: "https://accounts.google.com", aud: CID, exp: Math.floor(Date.now() / 1000) + 600, nonce, ...claims }) }), { status: 200 });
  }));
  const { GET: callback } = await import("@/app/api/auth/google/callback/route");
  const q = opts.error ? `error=${opts.error}&state=${state}` : `code=4%2Fcode&state=${state}`;
  const res = await callback(new NextRequest(`https://t.local/api/auth/google/callback?${q}`, { headers: { ...H, cookie: opts.dropCookie ? "" : `google_login=${cookie}` } }));
  return { start: r, to, res, sent, state, cookie };
}
async function clientWith(email: string, extra: Record<string, unknown> = {}) {
  return prisma.client.create({ data: { brokerId, email, passwordHash: "x", fullName: "Gl Test", emailVerifiedAt: new Date(), ...extra } });
}

describe("flag and Google URL", () => {
  it("is on only for the listed brokers", () => {
    expect(googleLoginEnabledFor("qoretrader", "qoretrader")).toBe(true);
    expect(googleLoginEnabledFor("futurixglobal", "qoretrader")).toBe(false);
    expect(googleLoginEnabledFor("tradenextfx", "qoretrader")).toBe(false);
    expect(googleLoginEnabledFor("qoretrader", undefined)).toBe(false);
  });
  it("asks Google for the account chooser, code flow, PKCE S256, openid email profile", () => {
    const u = new URL(googleAuthUrl(CID, "https://my.qoretrader.com/api/auth/google/callback", "st", "no", "ver"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CID, redirect_uri: "https://my.qoretrader.com/api/auth/google/callback", response_type: "code", scope: "openid email profile",
      state: "st", nonce: "no", code_challenge: pkceChallenge("ver"), code_challenge_method: "S256", prompt: "select_account",
    });
  });
  it("checks the ID token's issuer, audience, expiry and nonce", () => {
    const ok = { iss: "https://accounts.google.com", aud: CID, exp: 2000, nonce: "n", email: "A@x.com", email_verified: true };
    expect(checkIdToken(idToken(ok), CID, "n", 1000)).toEqual({ email: "a@x.com", emailVerified: true, name: null });
    expect(checkIdToken(idToken({ ...ok, iss: "https://evil" }), CID, "n", 1000)).toBeNull();
    expect(checkIdToken(idToken({ ...ok, aud: "other" }), CID, "n", 1000)).toBeNull();
    expect(checkIdToken(idToken({ ...ok, exp: 999 }), CID, "n", 1000)).toBeNull();
    expect(checkIdToken(idToken({ ...ok, nonce: "m" }), CID, "n", 1000)).toBeNull();
  });
});

describe("routes", () => {
  it("a verified Google email of an existing client signs that client in", async () => {
    if (!dbReachable) return;
    const c = await clientWith(`one-${s}@t.local`);
    const { to, res, sent } = await trip({ email: `One-${s}@t.local`, email_verified: true });
    expect(to.hostname).toBe("accounts.google.com");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://t.local/room");
    expect(res.cookies.get("vyx_client_session")?.value).toBeTruthy();
    // the code went with the PKCE verifier and the secret, server to server
    expect(sent[0]).toContain("grant_type=authorization_code");
    expect(sent[0]).toContain("code_verifier=");
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.lastLoginAt).not.toBeNull();
    // nothing of Google's is kept: no token in Redis, none on the client
    expect([...store.values()].some((e) => e.v.includes("ya29") || e.v.includes("sig"))).toBe(false);
    expect(JSON.stringify(after)).not.toContain("ya29");
  });

  it("no client with that email: /register with the email filled in, no session", async () => {
    if (!dbReachable) return;
    const { res } = await trip({ email: `new-${s}@t.local`, email_verified: true });
    expect(res.headers.get("location")).toBe(`https://t.local/register?google=1&email=${encodeURIComponent(`new-${s}@t.local`)}`);
    expect(res.cookies.get("vyx_client_session")).toBeUndefined();
  });

  it("an email Google has not verified does not sign in", async () => {
    if (!dbReachable) return;
    await clientWith(`unv-${s}@t.local`);
    const { res } = await trip({ email: `unv-${s}@t.local`, email_verified: false });
    expect(res.headers.get("location")).toBe("https://t.local/login?google=unverified");
    expect(res.cookies.get("vyx_client_session")).toBeUndefined();
  });

  it("another browser cannot finish the trip (no state cookie), and a state works once", async () => {
    if (!dbReachable) return;
    await clientWith(`csrf-${s}@t.local`);
    const a = await trip({ email: `csrf-${s}@t.local`, email_verified: true }, { dropCookie: true });
    expect(a.res.headers.get("location")).toBe("https://t.local/login?google=expired");
    const b = await trip({ email: `csrf-${s}@t.local`, email_verified: true });
    expect(b.res.headers.get("location")).toBe("https://t.local/room");
    const { GET: callback } = await import("@/app/api/auth/google/callback/route");
    const again = await callback(new NextRequest(`https://t.local/api/auth/google/callback?code=x&state=${b.state}`, { headers: { ...H, cookie: `google_login=${b.cookie}` } }));
    expect(again.headers.get("location")).toBe("https://t.local/login?google=expired");
  });

  it("cancel on Google comes back as cancelled", async () => {
    if (!dbReachable) return;
    const { res } = await trip({}, { error: "access_denied" });
    expect(res.headers.get("location")).toBe("https://t.local/login?google=cancelled");
  });

  it("2FA on: Google alone makes no session; the authenticator code does", async () => {
    if (!dbReachable) return;
    const secret = generateTotpSecret();
    await clientWith(`tfa-${s}@t.local`, { twoFactorEnabled: true, twoFactorSecret: secret });
    const { res } = await trip({ email: `tfa-${s}@t.local`, email_verified: true });
    expect(res.headers.get("location")).toBe("https://t.local/login?google=2fa");
    expect(res.cookies.get("vyx_client_session")).toBeUndefined();
    const ticket = res.cookies.get("google_2fa")!.value;
    const { POST } = await import("@/app/api/auth/google/2fa/route");
    const post = (code: string, t = ticket) => POST(new NextRequest("https://t.local/api/auth/google/2fa", { method: "POST", headers: { ...H, cookie: `google_2fa=${t}`, "content-type": "application/json" }, body: JSON.stringify({ code }) }));
    const wrong = await post("000000");
    expect(wrong.status).toBe(401);
    expect(wrong.cookies.get("vyx_client_session")).toBeUndefined();
    expect((await post("123456", "forged")).status).toBe(401);
    const ok = await post("123456");
    expect(ok.status).toBe(200);
    expect(ok.cookies.get("vyx_client_session")?.value).toBeTruthy();
    // the ticket is used once
    expect((await post("123456")).status).toBe(401);
  });

  it("the flag off: the start sends back to /login", async () => {
    if (!dbReachable) return;
    const before = process.env.GOOGLE_LOGIN_ENABLED;
    process.env.GOOGLE_LOGIN_ENABLED = "qoretrader";
    const { GET: start } = await import("@/app/api/auth/google/start/route");
    const r = await start(new NextRequest("https://t.local/api/auth/google/start", { headers: H }));
    expect(r.headers.get("location")).toBe("https://t.local/login");
    process.env.GOOGLE_LOGIN_ENABLED = before;
  });
});

describe("sign-in page", () => {
  it("or + Continue with Google under Sign in, only when on; the code step after Google", () => {
    const form = read("app/(broker)/room/login/LoginForm.tsx");
    expect(form).toContain('<div className="r-or" aria-hidden="true">or</div>');
    expect(form).toContain("<span>Continue with Google</span>");
    expect(form.indexOf("<span>Continue with Google</span>")).toBeGreaterThan(form.indexOf('"Sign in"}</button>'));
    expect(read("app/(broker)/room/login/LoginView.tsx")).toContain("const googleOn = googleLoginOn(broker.subdomain);");
    expect(form).toContain('fetch("/api/auth/google/2fa"');
    expect(read("app/(broker)/room/register/RegisterForm.tsx")).toContain("useState(initialEmail)");
  });
});
