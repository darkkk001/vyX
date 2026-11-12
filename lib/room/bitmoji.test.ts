import "dotenv/config";
import { readFileSync } from "node:fs";
import crypto, { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  BITMOJI_COOKIE, BITMOJI_SCOPE, attemptCookie, bitmojiEnabledFor, isBitmojiAvatarUrl, newConnectAttempt, readAttemptCookie, shownAvatar, snapAuthUrl,
} from "@/lib/room/bitmoji";

// Bitmoji connect, test version (owner 2026-11-12): QoreTrader only, behind BITMOJI_CONNECT_ENABLED; a verified client
// connects through Snap Login Kit (public client, PKCE), the avatar's image URL is saved on Client, Disconnect brings
// the initials back. Routes run against a real database; Snap's two endpoints are stubbed.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));

const read = (p: string) => readFileSync(p, "utf8");
const s = randomUUID().replace(/-/g, "").slice(0, 10);
const SUB = `bm-${s}`;
const AVATAR = "https://sdk.bitmoji.com/render/panel/abc-123-v1.png?transparent=1&palette=1";
let dbReachable = false;
let brokerId = "";
let seq = 0;

beforeAll(async () => {
  process.env.BITMOJI_CONNECT_ENABLED = `othertenant, ${SUB}`;
  process.env.SNAP_KIT_CLIENT_ID = "00000000-1111-2222-3333-444444444444";
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("bitmoji.test.ts: DB unreachable, skipping route cases"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Bm ${s}`, subdomain: SUB } })).id;
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client(kyc: "APPROVED" | "PENDING" | null, subdomain = SUB) {
  const n = ++seq;
  const c = await prisma.client.create({ data: { brokerId, email: `bm-${n}-${s}@t.local`, passwordHash: "x", fullName: "Bm Test" } });
  if (kyc) await prisma.clientKycRecord.create({ data: { clientId: c.id, status: kyc, documentType: "passport", documentFrontUrl: "x" } });
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: c.id, brokerId, broker: { id: brokerId, name: "Bm", subdomain } } } as never);
  return c;
}
async function start() {
  const { GET } = await import("@/app/api/bitmoji/start/route");
  return GET(new NextRequest("https://t.local/api/bitmoji/start", { headers: { "x-forwarded-proto": "https", host: "t.local" } }));
}
async function callback(query: string, cookie?: string) {
  const { GET } = await import("@/app/api/bitmoji/callback/route");
  const headers: Record<string, string> = { "x-forwarded-proto": "https", host: "t.local" };
  if (cookie) headers.cookie = `${BITMOJI_COOKIE}=${cookie}`;
  return GET(new NextRequest(`https://t.local/api/bitmoji/callback?${query}`, { headers }));
}
/** Snap stubbed: the token endpoint and /v1/me; records what was sent. */
function stubSnap(avatar: unknown = AVATAR, tokenStatus = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("https://accounts.snapchat.com/accounts/oauth2/token")) {
      return new Response(JSON.stringify(tokenStatus === 200 ? { access_token: "tok", token_type: "Bearer", expires_in: 3600 } : { error: "invalid_grant" }), { status: tokenStatus });
    }
    if (url === "https://kit.snapchat.com/v1/me") return new Response(JSON.stringify({ data: { me: { bitmoji: avatar === null ? null : { avatar } } } }), { status: 200 });
    return new Response("not stubbed", { status: 599 });
  }));
  return calls;
}
const saved = async (id: string) => (await prisma.client.findUniqueOrThrow({ where: { id }, select: { bitmojiAvatarUrl: true, bitmojiConnectedAt: true } }));

describe("flag, PKCE and the avatar URL check", () => {
  it("BITMOJI_CONNECT_ENABLED lists broker subdomains; unset, empty or '1' is off", () => {
    expect(bitmojiEnabledFor("qoretrader", "qoretrader")).toBe(true);
    expect(bitmojiEnabledFor("qoretrader", " QoreTrader , other")).toBe(true);
    expect(bitmojiEnabledFor("futurixglobal", "qoretrader")).toBe(false);
    expect(bitmojiEnabledFor("tradenextfx", "qoretrader")).toBe(false);
    expect(bitmojiEnabledFor("qoretrader", undefined)).toBe(false);
    expect(bitmojiEnabledFor("qoretrader", "")).toBe(false);
    expect(bitmojiEnabledFor("qoretrader", "1")).toBe(false);
  });
  it("S256 challenge of the verifier, Snap's auth URL with the Bitmoji scope", () => {
    const a = newConnectAttempt();
    expect(a.challenge).toBe(crypto.createHash("sha256").update(a.verifier).digest("base64url"));
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    const u = new URL(snapAuthUrl("cid", "https://my.qoretrader.com/api/bitmoji/callback", a.state, a.challenge));
    expect(u.origin + u.pathname).toBe("https://accounts.snapchat.com/accounts/oauth2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid", redirect_uri: "https://my.qoretrader.com/api/bitmoji/callback", response_type: "code", scope: BITMOJI_SCOPE,
      state: a.state, code_challenge: a.challenge, code_challenge_method: "S256",
    });
  });
  it("attempt cookie round trip; a broken one is refused", () => {
    expect(readAttemptCookie(attemptCookie("c1", "st", "ver"))).toEqual({ clientId: "c1", state: "st", verifier: "ver" });
    expect(readAttemptCookie("c1.st")).toBeNull();
    expect(readAttemptCookie(undefined)).toBeNull();
  });
  it("only https images on Bitmoji / Snap hosts", () => {
    expect(isBitmojiAvatarUrl(AVATAR)).toBe(true);
    expect(isBitmojiAvatarUrl("https://images.bitmoji.com/3d/avatar/1.webp")).toBe(true);
    expect(isBitmojiAvatarUrl("http://sdk.bitmoji.com/x.png")).toBe(false);
    expect(isBitmojiAvatarUrl("https://sdk.bitmoji.com.evil.com/x.png")).toBe(false);
    expect(isBitmojiAvatarUrl("https://evil.com/bitmoji.com/x.png")).toBe(false);
    expect(isBitmojiAvatarUrl("javascript:alert(1)")).toBe(false);
    expect(isBitmojiAvatarUrl("https://user:pw@sdk.bitmoji.com/x.png")).toBe(false);
    expect(isBitmojiAvatarUrl(42)).toBe(false);
  });
  it("shown only while the flag is on for the broker", () => {
    expect(shownAvatar(SUB, AVATAR)).toBe(AVATAR);
    expect(shownAvatar("futurixglobal", AVATAR)).toBeNull();
    expect(shownAvatar(SUB, null)).toBeNull();
    expect(shownAvatar(SUB, "https://evil.com/x.png")).toBeNull();
  });
});

describe("Connect: /api/bitmoji/start", () => {
  it("unverified client: back to Profile, no Snap, no cookie", async () => {
    if (!dbReachable) return;
    await client("PENDING");
    const r = await start();
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://t.local/room/profile?bitmoji=verify");
    expect(r.cookies.get(BITMOJI_COOKIE)).toBeUndefined();
  });
  it("broker without the flag (Futurix, TradeNext): off", async () => {
    if (!dbReachable) return;
    await client("APPROVED", "futurixglobal");
    const r = await start();
    expect(r.headers.get("location")).toBe("https://t.local/room/profile?bitmoji=off");
  });
  it("verified client: to Snap's sign-in with PKCE; the attempt cookie is httpOnly and bound to the client", async () => {
    if (!dbReachable) return;
    const c = await client("APPROVED");
    const r = await start();
    expect(r.status).toBe(303);
    const to = new URL(r.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.snapchat.com/accounts/oauth2/auth");
    expect(to.searchParams.get("client_id")).toBe(process.env.SNAP_KIT_CLIENT_ID);
    expect(to.searchParams.get("redirect_uri")).toBe("https://t.local/api/bitmoji/callback");
    expect(to.searchParams.get("scope")).toBe(BITMOJI_SCOPE);
    const ck = r.cookies.get(BITMOJI_COOKIE)!;
    expect(ck.httpOnly).toBe(true);
    expect(ck.path).toBe("/api/bitmoji");
    const att = readAttemptCookie(ck.value)!;
    expect(att.clientId).toBe(c.id);
    expect(att.state).toBe(to.searchParams.get("state"));
    expect(crypto.createHash("sha256").update(att.verifier).digest("base64url")).toBe(to.searchParams.get("code_challenge"));
  });
});

describe("Callback: /api/bitmoji/callback", () => {
  it("saves the avatar URL; the token exchange is PKCE with no secret; Snap's token is not stored", async () => {
    if (!dbReachable) return;
    const c = await client("APPROVED");
    const calls = stubSnap();
    const r = await callback("code=abc&state=st1", attemptCookie(c.id, "st1", "verifier-1"));
    expect(r.headers.get("location")).toBe("https://t.local/room/profile?bitmoji=connected");
    expect(r.cookies.get(BITMOJI_COOKIE)?.value).toBe("");
    const row = await saved(c.id);
    expect(row.bitmojiAvatarUrl).toBe(AVATAR);
    expect(row.bitmojiConnectedAt).toBeInstanceOf(Date);
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(Object.fromEntries(body)).toEqual({ grant_type: "authorization_code", code: "abc", redirect_uri: "https://t.local/api/bitmoji/callback", client_id: process.env.SNAP_KIT_CLIENT_ID, code_verifier: "verifier-1" });
    expect(calls[1].url).toBe("https://kit.snapchat.com/v1/me");
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ query: "{me{bitmoji{avatar}}}" });
  });
  it("state mismatch, no cookie, or a cookie from another client: expired, nothing saved, Snap not called", async () => {
    if (!dbReachable) return;
    const c = await client("APPROVED");
    const calls = stubSnap();
    expect((await callback("code=abc&state=WRONG", attemptCookie(c.id, "st1", "v"))).headers.get("location")).toContain("bitmoji=expired");
    expect((await callback("code=abc&state=st1")).headers.get("location")).toContain("bitmoji=expired");
    expect((await callback("code=abc&state=st1", attemptCookie("someone-else", "st1", "v"))).headers.get("location")).toContain("bitmoji=expired");
    expect(calls).toHaveLength(0);
    expect((await saved(c.id)).bitmojiAvatarUrl).toBeNull();
  });
  it("cancelled at Snap, a refused code, no Bitmoji, or a URL off Bitmoji's hosts: nothing saved", async () => {
    if (!dbReachable) return;
    const c = await client("APPROVED");
    const ck = attemptCookie(c.id, "st1", "v");
    stubSnap();
    expect((await callback("error=access_denied&state=st1", ck)).headers.get("location")).toContain("bitmoji=cancelled");
    stubSnap(AVATAR, 400);
    expect((await callback("code=abc&state=st1", ck)).headers.get("location")).toContain("bitmoji=failed");
    stubSnap(null);
    expect((await callback("code=abc&state=st1", ck)).headers.get("location")).toContain("bitmoji=no-avatar");
    stubSnap("https://evil.com/x.png");
    expect((await callback("code=abc&state=st1", ck)).headers.get("location")).toContain("bitmoji=failed");
    expect((await saved(c.id)).bitmojiAvatarUrl).toBeNull();
  });
  it("KYC no longer approved by the time Snap answers: verify, nothing saved", async () => {
    if (!dbReachable) return;
    const c = await client("PENDING");
    const calls = stubSnap();
    expect((await callback("code=abc&state=st1", attemptCookie(c.id, "st1", "v"))).headers.get("location")).toContain("bitmoji=verify");
    expect(calls).toHaveLength(0);
  });
});

describe("Disconnect: DELETE /api/bitmoji", () => {
  it("removes the Bitmoji, so the initials come back", async () => {
    if (!dbReachable) return;
    const c = await client("APPROVED");
    await prisma.client.update({ where: { id: c.id }, data: { bitmojiAvatarUrl: AVATAR, bitmojiConnectedAt: new Date() } });
    const { DELETE } = await import("@/app/api/bitmoji/route");
    const r = await DELETE();
    expect(r.status).toBe(200);
    expect(await saved(c.id)).toEqual({ bitmojiAvatarUrl: null, bitmojiConnectedAt: null });
  });
});

describe("where it shows", () => {
  it("stored on Client, migrated", () => {
    expect(read("prisma/schema.prisma")).toMatch(/\n[ \t]+bitmojiAvatarUrl[ \t]+String\?\r?\n/);
    const sql = read("prisma/migrations/20261112150000_client_bitmoji/migration.sql");
    expect(sql).toContain('ALTER TABLE "Client" ADD COLUMN "bitmojiAvatarUrl" TEXT;');
    expect(sql).toContain('ALTER TABLE "Client" ADD COLUMN "bitmojiConnectedAt" TIMESTAMPTZ(3);');
  });
  it("top bar: the Bitmoji when connected, else the initials as before", () => {
    const m = read("components/room/UserMenu.tsx");
    expect(m).toContain('<img className="r-avatar r-avatar-img" src={data.client.avatarUrl} alt="" referrerPolicy="no-referrer" />');
    expect(m).toContain(') : <span className="r-avatar">{initials(data.client.fullName)}</span>}');
    expect(read("app/api/room/overview/route.ts")).toContain("avatarUrl: shownAvatar(session.broker.subdomain, client.bitmojiAvatarUrl)");
  });
  it("Profile: Connect Bitmoji for verified clients, Disconnect once connected, only where the flag is on", () => {
    const pg = read("app/(broker)/room/(shell)/profile/page.tsx");
    expect(pg).toContain('<a className="r-btn r-btn-sm" href="/api/bitmoji/start">Connect Bitmoji</a>');
    expect(pg).toContain('{bmBusy ? "Disconnecting…" : "Disconnect"}');
    expect(pg).toContain("p?.bitmoji && (p.bitmoji.avatarUrl || p.bitmoji.canConnect)");
    const route = read("app/api/room/profile/route.ts");
    expect(route).toContain("bitmojiEnabledFor(ctx.session.broker.subdomain) && snapClientId()");
    expect(route).toContain('canConnect: kyc?.status === "APPROVED"');
  });
});
