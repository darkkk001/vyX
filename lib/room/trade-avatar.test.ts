import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/trade/avatar (owner 2026-11-12, share card 2026-11-14): the signed-in trading account's own client's
// avatar (Bitmoji behind BITMOJI_CONNECT_ENABLED, else the chosen preset, else none), referral code + register link +
// QR, and the preset lists. The account comes only from the trading session. Real database; the session is stubbed.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
const ON = `ta-${s}`;
const OFF = `tb-${s}`;
const SAVED = "https://images.bitmoji.com/3d/render/abc-123?trim=circle&ua=2";
const HOST = "https://t.local";
let dbReachable = false;
const ids: Record<string, { broker: string; account: string }> = {};
let n = 0;

async function accountFor(brokerId: string, c: { bitmoji?: string | null; preset?: string | null; fullName?: string } | "none") {
  const client = c === "none" ? null : await prisma.client.create({ data: { brokerId, email: `ta-${++n}-${s}@t.local`, passwordHash: "x", fullName: c.fullName ?? "Jade Stevens", bitmojiAvatarUrl: c.bitmoji ?? null, avatarPreset: c.preset ?? null } });
  const groupId = (await prisma.group.findFirst({ where: { brokerId } }))?.id ?? (await prisma.group.create({ data: { brokerId, name: "g", displayName: "Standard", leverage: 100, category: "B_BOOK" } })).id;
  const a = await prisma.account.create({ data: { brokerId, groupId, clientId: client?.id ?? null, accountNumber: `9${Date.now() % 1_000_000}${++n}`, email: `ta-a-${n}-${s}@t.local`, passwordHash: "x", fullName: "Ta", accountMode: "DEMO" } });
  return a.id;
}
type Body = { nameTag: string | null; avatarUrl: string | null; type: string; preset: string | null; imageUrl: string | null; referralCode: string | null; registerUrl: string | null; qr: string | null; presets: { profit: { name: string; imageUrl: string; bg: string }[]; loss: { name: string }[] } };
async function get(accountId: string | null, brokerId = "") {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue(accountId ? ({ accountId, brokerId } as never) : null);
  const { GET } = await import("@/app/api/trade/avatar/route");
  const res = await GET(new NextRequest(`${HOST}/api/trade/avatar`, { headers: { host: "t.local", "x-forwarded-proto": "https" } }));
  return { status: res.status, body: (await res.json()) as Body, cache: res.headers.get("cache-control") };
}

beforeAll(async () => {
  process.env.BITMOJI_CONNECT_ENABLED = `x, ${ON}`;
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("trade-avatar.test.ts: DB unreachable, skipping"); return; }
  for (const sub of [ON, OFF]) {
    const b = await prisma.broker.create({ data: { name: `Ta ${sub}`, subdomain: sub } });
    ids[sub] = { broker: b.id, account: await accountFor(b.id, { bitmoji: SAVED, preset: "wolf" }) };
  }
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

describe("GET /api/trade/avatar", () => {
  it("signed out: 401", async () => {
    if (!dbReachable) return;
    expect((await get(null)).status).toBe(401);
  });
  it("Bitmoji connected (flag on): the Bitmoji, drawn the Room's way (no trim), the preset kept; never cached", async () => {
    if (!dbReachable) return;
    const r = await get(ids[ON].account, ids[ON].broker);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ avatarUrl: "https://images.bitmoji.com/3d/render/abc-123?ua=2", type: "bitmoji", preset: "wolf", imageUrl: "https://images.bitmoji.com/3d/render/abc-123?ua=2" });
    expect(r.cache).toBe("private, no-store");
  });
  it("flag off for the broker: the chosen preset (256 for the badge, 1024 for the card), absolute", async () => {
    if (!dbReachable) return;
    expect((await get(ids[OFF].account, ids[OFF].broker)).body).toMatchObject({ type: "preset", preset: "wolf", avatarUrl: `${HOST}/avatars/wolf-256.webp`, imageUrl: `${HOST}/avatars/wolf-1024.webp` });
  });
  it("nothing chosen, or a name that is no preset: none", async () => {
    if (!dbReachable) return;
    for (const preset of [null, "../etc"]) {
      const a = await accountFor(ids[ON].broker, { preset });
      expect((await get(a, ids[ON].broker)).body).toMatchObject({ type: "none", preset: null, avatarUrl: null, imageUrl: null });
    }
  });
  it("every client gets a referral code (8-9 characters, kept), the broker's register link with it and its QR", async () => {
    if (!dbReachable) return;
    const a = await accountFor(ids[ON].broker, { fullName: "Jade Stevens" });
    const one = (await get(a, ids[ON].broker)).body;
    expect(one.referralCode).toMatch(/^JADES[A-HJ-NP-Z2-9]{4}$/);
    expect(one.registerUrl).toBe(`${HOST}/register?ref=${one.referralCode}`);
    expect(one.qr).toMatch(/^data:image\/png;base64,/);
    expect((await get(a, ids[ON].broker)).body.referralCode).toBe(one.referralCode);
    const short = (await get(await accountFor(ids[ON].broker, { fullName: "Al" }), ids[ON].broker)).body.referralCode!;
    expect(short).toMatch(/^AL[A-HJ-NP-Z2-9]{6}$/);
  });
  it("a code made before (the old format) is kept as it is", async () => {
    if (!dbReachable) return;
    const a = await accountFor(ids[ON].broker, {});
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: a }, select: { clientId: true } });
    await prisma.client.update({ where: { id: acc.clientId! }, data: { referralCode: `JS${s.slice(0, 4).toUpperCase()}` } });
    expect((await get(a, ids[ON].broker)).body.referralCode).toBe(`JS${s.slice(0, 4).toUpperCase()}`);
  });
  it("name tag: the account's nickname, else the client's name", async () => {
    if (!dbReachable) return;
    const a = await accountFor(ids[ON].broker, { fullName: "Jade Stevens" });
    expect((await get(a, ids[ON].broker)).body.nameTag).toBe("Jade Stevens");
    await prisma.account.update({ where: { id: a }, data: { nickname: "TheBullion" } });
    expect((await get(a, ids[ON].broker)).body.nameTag).toBe("TheBullion");
  });
  it("an account with no CRM client: no avatar, no referral", async () => {
    if (!dbReachable) return;
    const orphan = await accountFor(ids[ON].broker, "none");
    expect((await get(orphan, ids[ON].broker)).body).toMatchObject({ type: "none", avatarUrl: null, referralCode: null, registerUrl: null, qr: null });
  });
  it("the preset lists: profit in the owner's order, loss = bear first then the rest, absolute 1024 links", async () => {
    if (!dbReachable) return;
    const { presets } = (await get(ids[ON].account, ids[ON].broker)).body;
    expect(presets.profit.map((p) => p.name)).toEqual(["coin_crown", "coin_laurel", "samurai_moon", "samurai_sun", "bull", "wolf", "phoenix", "owl", "silhouette", "gentleman", "trader", "dragon", "ninja"]);
    expect(presets.loss.map((p) => p.name)).toEqual(["bear", ...presets.profit.map((p) => p.name)]);
    expect(presets.profit[0]).toEqual({ name: "coin_crown", imageUrl: `${HOST}/avatars/coin_crown-1024.webp`, bg: "#120E07" });
  });
  it("takes no account from the request: only the session's account, and only under its own broker", async () => {
    if (!dbReachable) return;
    const src = readFileSync("app/api/trade/avatar/route.ts", "utf8");
    expect(src).toContain("where: { id: session.accountId }");
    expect((await get(ids[ON].account, ids[OFF].broker)).body).toMatchObject({ type: "none", avatarUrl: null, referralCode: null });
  });
});

describe("WebTrader badge", () => {
  it("the avatar when there is one, else the account digits as before", () => {
    const w = readFileSync("components/webtrader/WebTrader.tsx", "utf8");
    expect(w).toContain('fetch("/api/trade/avatar", { cache: "no-store" })');
    expect(w).toContain('<img className="avatar avatar-img" src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setAvatarUrl(null)} />');
    expect(w).toContain('<div className="avatar">{account?.accountNumber?.slice(-2) ?? ""}</div>');
  });
});
