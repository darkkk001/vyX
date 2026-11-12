import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

// GET /api/trade/avatar (owner 2026-11-12): the signed-in trading account's own client's Bitmoji for the WebTrader /
// terminal badge, behind BITMOJI_CONNECT_ENABLED. The account comes only from the trading session. Real database;
// the session is stubbed.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
const ON = `ta-${s}`;
const OFF = `tb-${s}`;
const SAVED = "https://images.bitmoji.com/3d/render/abc-123?trim=circle&ua=2";
let dbReachable = false;
const ids: Record<string, { broker: string; account: string }> = {};
let n = 0;

async function accountFor(brokerId: string, clientAvatar: string | null | "none") {
  const c = clientAvatar === "none" ? null : await prisma.client.create({ data: { brokerId, email: `ta-${++n}-${s}@t.local`, passwordHash: "x", fullName: "Ta", bitmojiAvatarUrl: clientAvatar } });
  const groupId = (await prisma.group.findFirst({ where: { brokerId } }))?.id ?? (await prisma.group.create({ data: { brokerId, name: "g", displayName: "Standard", leverage: 100, category: "B_BOOK" } })).id;
  const a = await prisma.account.create({ data: { brokerId, groupId, clientId: c?.id ?? null, accountNumber: `9${Date.now() % 1_000_000}${++n}`, email: `ta-a-${n}-${s}@t.local`, passwordHash: "x", fullName: "Ta", accountMode: "DEMO" } });
  return a.id;
}
async function get(accountId: string | null, brokerId = "", url = "https://t.local/api/trade/avatar") {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue(accountId ? ({ accountId, brokerId } as never) : null);
  const { GET } = await import("@/app/api/trade/avatar/route");
  void url;
  const res = await GET();
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
}

beforeAll(async () => {
  process.env.BITMOJI_CONNECT_ENABLED = `x, ${ON}`;
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("trade-avatar.test.ts: DB unreachable, skipping"); return; }
  for (const sub of [ON, OFF]) {
    const b = await prisma.broker.create({ data: { name: `Ta ${sub}`, subdomain: sub } });
    ids[sub] = { broker: b.id, account: await accountFor(b.id, SAVED) };
  }
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

describe("GET /api/trade/avatar", () => {
  it("signed out: 401", async () => {
    if (!dbReachable) return;
    expect((await get(null)).status).toBe(401);
  });
  it("the account's own client's Bitmoji, drawn the Room's way (no trim), never cached", async () => {
    if (!dbReachable) return;
    const r = await get(ids[ON].account, ids[ON].broker);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ avatarUrl: "https://images.bitmoji.com/3d/render/abc-123?ua=2" });
    expect(r.cache).toBe("private, no-store");
  });
  it("flag off for the broker: null", async () => {
    if (!dbReachable) return;
    expect((await get(ids[OFF].account, ids[OFF].broker)).body).toEqual({ avatarUrl: null });
  });
  it("no Bitmoji, or an account with no CRM client: null", async () => {
    if (!dbReachable) return;
    const plain = await accountFor(ids[ON].broker, null);
    const orphan = await accountFor(ids[ON].broker, "none");
    expect((await get(plain, ids[ON].broker)).body).toEqual({ avatarUrl: null });
    expect((await get(orphan, ids[ON].broker)).body).toEqual({ avatarUrl: null });
  });
  it("takes no account from the request: only the session's account, and only under its own broker", async () => {
    if (!dbReachable) return;
    const src = readFileSync("app/api/trade/avatar/route.ts", "utf8");
    expect(src).toContain("export async function GET() {");
    expect(src).toContain("where: { id: session.accountId }");
    // a session whose broker does not match the account's gets nothing
    expect((await get(ids[ON].account, ids[OFF].broker)).body).toEqual({ avatarUrl: null });
  });
});

describe("WebTrader badge", () => {
  it("the Bitmoji when there is one, else the account digits as before", () => {
    const w = readFileSync("components/webtrader/WebTrader.tsx", "utf8");
    expect(w).toContain('fetch("/api/trade/avatar", { cache: "no-store" })');
    expect(w).toContain('<img className="avatar avatar-img" src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setAvatarUrl(null)} />');
    expect(w).toContain('<div className="avatar">{account?.accountNumber?.slice(-2) ?? ""}</div>');
  });
});
