import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  BITMOJI_COOKIE, BITMOJI_SCOPE, attemptCookie, bitmojiEnabledFor, isBitmojiAvatarUrl, newConnectState, readAttemptCookie, shownAvatar, snapAuthUrl,
} from "@/lib/room/bitmoji";

// Bitmoji connect, test version (owner 2026-11-12): QoreTrader only, behind BITMOJI_CONNECT_ENABLED; a verified client
// connects through Snap Login Kit web with the URL Snap's own SDK builds (implicit grant), the avatar's image URL is
// saved on Client, Disconnect brings the initials back. Routes run against a real database; Snap's /v1/me is stubbed.
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
async function landing(query: string) {
  const { GET } = await import("@/app/api/bitmoji/callback/route");
  return GET(new NextRequest(`https://t.local/api/bitmoji/callback${query ? `?${query}` : ""}`, { headers: { "x-forwarded-proto": "https", host: "t.local" } }));
}
/** What the landing page's form posts: the fragment's access_token, state and error. */
async function callback(fields: Record<string, string>, cookie?: string) {
  const { POST } = await import("@/app/api/bitmoji/callback/route");
  const headers: Record<string, string> = { "x-forwarded-proto": "https", host: "t.local", "content-type": "application/x-www-form-urlencoded" };
  if (cookie) headers.cookie = `${BITMOJI_COOKIE}=${cookie}`;
  return POST(new NextRequest("https://t.local/api/bitmoji/callback", { method: "POST", headers, body: new URLSearchParams({ access_token: "", state: "", error: "", ...fields }).toString() }));
}
/** Snap stubbed: /v1/me; records what was sent. */
function stubSnap(avatar: unknown = AVATAR, meStatus = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://kit.snapchat.com/v1/me") {
      return new Response(JSON.stringify(meStatus === 200 ? { data: { me: { bitmoji: avatar === null ? null : { avatar } } } } : { message: "unauthorized" }), { status: meStatus });
    }
    return new Response("not stubbed", { status: 599 });
  }));
  return calls;
}
const saved = async (id: string) => (await prisma.client.findUniqueOrThrow({ where: { id }, select: { bitmojiAvatarUrl: true, bitmojiConnectedAt: true } }));

describe("flag, Snap's sign-in URL and the avatar URL check", () => {
  it("BITMOJI_CONNECT_ENABLED lists broker subdomains; unset, empty or '1' is off", () => {
    expect(bitmojiEnabledFor("qoretrader", "qoretrader")).toBe(true);
    expect(bitmojiEnabledFor("qoretrader", " QoreTrader , other")).toBe(true);
    expect(bitmojiEnabledFor("futurixglobal", "qoretrader")).toBe(false);
    expect(bitmojiEnabledFor("tradenextfx", "qoretrader")).toBe(false);
    expect(bitmojiEnabledFor("qoretrader", undefined)).toBe(false);
    expect(bitmojiEnabledFor("qoretrader", "")).toBe(false);
    expect(bitmojiEnabledFor("qoretrader", "1")).toBe(false);
  });
  it("the URL Snap's web SDK builds (getImplicitRedirectURL): same parameters, order and encoding", () => {
    const state = newConnectState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = snapAuthUrl("cid", "https://my.qoretrader.com/api/bitmoji/callback", state);
    // The SDK: query-string stringify of { client_id, redirect_uri, response_type: "token", scope, state }, scopes as
    // OAUTH_SCOPE_URL_PREFIX + name joined by a space.
    expect(url).toBe(
      "https://accounts.snapchat.com/accounts/oauth2/auth?client_id=cid"
      + "&redirect_uri=https%3A%2F%2Fmy.qoretrader.com%2Fapi%2Fbitmoji%2Fcallback"
      + "&response_type=token"
      + "&scope=https%3A%2F%2Fauth.snapchat.com%2Foauth2%2Fapi%2Fuser.display_name%20https%3A%2F%2Fauth.snapchat.com%2Foauth2%2Fapi%2Fuser.bitmoji.avatar"
      + `&state=${state}`,
    );
    expect(BITMOJI_SCOPE).toBe("https://auth.snapchat.com/oauth2/api/user.display_name https://auth.snapchat.com/oauth2/api/user.bitmoji.avatar");
    expect(url).not.toContain("code_challenge");
  });
  it("attempt cookie round trip; a broken one is refused", () => {
    expect(readAttemptCookie(attemptCookie("c1", "st"))).toEqual({ clientId: "c1", state: "st" });
    expect(readAttemptCookie("c1.st.x")).toBeNull();
    expect(readAttemptCookie("c1")).toBeNull();
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
  it("verified client: to Snap's sign-in (implicit, as the SDK); the attempt cookie is httpOnly and bound to the client", async () => {
    if (!dbReachable) return;
    const c = await client("APPROVED");
    const r = await start();
    expect(r.status).toBe(303);
    const to = new URL(r.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.snapchat.com/accounts/oauth2/auth");
    expect(to.searchParams.get("client_id")).toBe(process.env.SNAP_KIT_CLIENT_ID);
    expect(to.searchParams.get("redirect_uri")).toBe("https://t.local/api/bitmoji/callback");
    expect(to.searchParams.get("scope")).toBe(BITMOJI_SCOPE);
    expect(to.searchParams.get("response_type")).toBe("token");
    const ck = r.cookies.get(BITMOJI_COOKIE)!;
    expect(ck.httpOnly).toBe(true);
    expect(ck.path).toBe("/api/bitmoji");
    const att = readAttemptCookie(ck.value)!;
    expect(att.clientId).toBe(c.id);
    expect(att.state).toBe(to.searchParams.get("state"));
  });
});

describe("Callback: /api/bitmoji/callback", () => {
  it("landing (GET): a page that posts the fragment's token and state back, and takes them off the address bar", async () => {
    if (!dbReachable) return;
    await client("APPROVED");
    const r = await landing("");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await r.text();
    expect(html).toContain('<form method="post" action="/api/bitmoji/callback">');
    expect(html).toContain("new URLSearchParams(location.hash.slice(1))");
    expect(html).toContain('history.replaceState(null,"",location.pathname)');
    expect((await landing("error=access_denied")).headers.get("location")).toBe("https://t.local/room/profile?bitmoji=cancelled");
  });
  it("landing on a broker without the flag: off", async () => {
    if (!dbReachable) return;
    await client("APPROVED", "futurixglobal");
    expect((await landing("")).headers.get("location")).toBe("https://t.local/room/profile?bitmoji=off");
  });
  it("saves the avatar URL read with Snap's token; the token is not stored", async () => {
    if (!dbReachable) return;
    const c = await client("APPROVED");
    const calls = stubSnap();
    const r = await callback({ access_token: "tok", state: "st1" }, attemptCookie(c.id, "st1"));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://t.local/room/profile?bitmoji=connected");
    expect(r.cookies.get(BITMOJI_COOKIE)?.value).toBe("");
    const row = await saved(c.id);
    expect(row.bitmojiAvatarUrl).toBe(AVATAR);
    expect(row.bitmojiConnectedAt).toBeInstanceOf(Date);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://kit.snapchat.com/v1/me");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: "{me{bitmoji{avatar}}}" });
  });
  it("state mismatch, no token, no cookie, or a cookie from another client: expired, nothing saved, Snap not called", async () => {
    if (!dbReachable) return;
    const c = await client("APPROVED");
    const calls = stubSnap();
    expect((await callback({ access_token: "tok", state: "WRONG" }, attemptCookie(c.id, "st1"))).headers.get("location")).toContain("bitmoji=expired");
    expect((await callback({ access_token: "", state: "st1" }, attemptCookie(c.id, "st1"))).headers.get("location")).toContain("bitmoji=expired");
    expect((await callback({ access_token: "tok", state: "st1" })).headers.get("location")).toContain("bitmoji=expired");
    expect((await callback({ access_token: "tok", state: "st1" }, attemptCookie("someone-else", "st1"))).headers.get("location")).toContain("bitmoji=expired");
    expect(calls).toHaveLength(0);
    expect((await saved(c.id)).bitmojiAvatarUrl).toBeNull();
  });
  it("cancelled at Snap, a refused token, no Bitmoji, or a URL off Bitmoji's hosts: nothing saved", async () => {
    if (!dbReachable) return;
    const c = await client("APPROVED");
    const ck = attemptCookie(c.id, "st1");
    stubSnap();
    expect((await callback({ error: "access_denied", state: "st1" }, ck)).headers.get("location")).toContain("bitmoji=cancelled");
    stubSnap(AVATAR, 401);
    expect((await callback({ access_token: "tok", state: "st1" }, ck)).headers.get("location")).toContain("bitmoji=failed");
    stubSnap(null);
    expect((await callback({ access_token: "tok", state: "st1" }, ck)).headers.get("location")).toContain("bitmoji=no-avatar");
    stubSnap("https://evil.com/x.png");
    expect((await callback({ access_token: "tok", state: "st1" }, ck)).headers.get("location")).toContain("bitmoji=failed");
    expect((await saved(c.id)).bitmojiAvatarUrl).toBeNull();
  });
  it("KYC no longer approved by the time Snap answers: verify, nothing saved", async () => {
    if (!dbReachable) return;
    const c = await client("PENDING");
    const calls = stubSnap();
    expect((await callback({ access_token: "tok", state: "st1" }, attemptCookie(c.id, "st1"))).headers.get("location")).toContain("bitmoji=verify");
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
