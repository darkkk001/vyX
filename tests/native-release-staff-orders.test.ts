import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Staff order brief (owner 2026-10-28 / 2026-10-29): staff market orders fill at the live price only, staff LIMIT / STOP orders, the Manual position
// (BROKER_ADMIN, audited, never touching the market) with its preview, the open time from the open price, and the "opened by dealer" flags.
vi.mock("@/lib/auth", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
const live = { bid: new Prisma.Decimal("4000.00"), ask: new Prisma.Decimal("4000.50") };
vi.mock("@/lib/live-price", async (importActual) => ({ ...(await importActual<typeof import("@/lib/live-price")>()), getFreshPrice: vi.fn(async () => live) }));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("native-release-staff-orders.test.ts: DB unreachable, skipping"); }
});
const brokers: string[] = [];
const symbols: string[] = [];
async function fixture(balance = "100000") {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Staff ${s}`, subdomain: `staff-${s}` } });
  brokers.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `ba-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const trader = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `mgr-${s}@test.local`, passwordHash: "x", role: "MANAGER", extraPermissions: ["CLIENT_TRADING"] } });
  const plain = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `plain-${s}@test.local`, passwordHash: "x", role: "MANAGER" } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `G-${s}`, leverage: 100, category: "B_BOOK", modeRestriction: "ANY" } });
  const symbol = await prisma.symbol.create({ data: { name: `XT${s.slice(0, 6).toUpperCase()}`, baseCurrency: "XAU", quoteCurrency: "USD", digits: 2, contractSize: new Prisma.Decimal(100), category: "METALS" } });
  symbols.push(symbol.id);
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, enabled: true, minLot: new Prisma.Decimal("0.01"), maxLot: new Prisma.Decimal("50"), lotStep: new Prisma.Decimal("0.01"), stopLevel: 0 } });
  await prisma.tradingSession.deleteMany({ where: { brokerSymbol: { brokerId: broker.id } } });
  const account = await prisma.account.create({
    data: { brokerId: broker.id, groupId: group.id, accountNumber: `7${Date.now() % 1e9}${Math.floor(Math.random() * 90 + 10)}`, email: "c@test.local", passwordHash: "x", fullName: "C", accountMode: "LIVE", balance: new Prisma.Decimal(balance), leverage: 100 },
  });
  return { broker, admin, trader, plain, group, symbol, account };
}
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.deal.deleteMany({ where: { accountId: { in: (await prisma.account.findMany({ where, select: { id: true } })).map((a) => a.id) } } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { account: where } }).catch(() => {});
  await prisma.position.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.brokerSymbol.deleteMany({ where });
  await prisma.symbol.deleteMany({ where: { id: { in: symbols } } }).catch(() => {});
  await prisma.group.deleteMany({ where });
  await prisma.adminUser.deleteMany({ where });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function as(a: { id: string; brokerId: string | null; role: string }) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, brokerId: a.brokerId, role: a.role } as never);
}
const req = (body: unknown) => new NextRequest("https://test.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("staff MARKET order: no price", () => {
  it("a request that sends price is refused for every role, never ignored", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { POST } = await import("@/app/api/manage/positions/route");
    for (const who of [fx.admin, fx.trader]) {
      await as(who);
      const r = await POST(req({ accountId: fx.account.id, symbolId: fx.symbol.id, side: "BUY", volume: "0.10", price: "3990" }));
      expect(r.status).toBe(400);
      expect((await r.json()).code).toBe("PRICE_NOT_ALLOWED");
    }
    expect(await prisma.position.count({ where: { accountId: fx.account.id } })).toBe(0);
    await as(fx.trader);
    const ok = await POST(req({ accountId: fx.account.id, symbolId: fx.symbol.id, side: "BUY", volume: "0.10" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).openPrice).toBe("4000.5");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.broker.id, action: "MANUAL_POSITION_OPEN" } });
    expect((audit.newValue as { activity: string }).activity).toBe(`Opened BUY 0.1 ${fx.symbol.name} for ${fx.account.accountNumber}`);
  });
});

describe("staff LIMIT / STOP order", () => {
  it("needs CLIENT_TRADING, checks the entry against the market and rests as PENDING with source ADMIN", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { POST } = await import("@/app/api/manage/accounts/[id]/orders/route");
    const p = { params: Promise.resolve({ id: fx.account.id }) };
    await as(fx.plain);
    expect((await POST(req({ symbolId: fx.symbol.id, side: "BUY", type: "LIMIT", volume: "0.10", price: "3950" }), p)).status).toBe(403);
    await as(fx.trader);
    expect((await POST(req({ symbolId: fx.symbol.id, side: "BUY", type: "LIMIT", volume: "0.10", price: "4050" }), { params: Promise.resolve({ id: fx.account.id }) })).status).toBe(400); // BUY LIMIT above the ask
    const ok = await POST(req({ symbolId: fx.symbol.id, side: "BUY", type: "LIMIT", volume: "0.10", price: "3950" }), { params: Promise.resolve({ id: fx.account.id }) });
    expect(ok.status).toBe(201);
    const order = await prisma.order.findFirstOrThrow({ where: { accountId: fx.account.id, type: "LIMIT" } });
    expect(order.status).toBe("PENDING");
    expect(order.source).toBe("ADMIN");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: "ORDER_PLACED" } });
    expect((audit.newValue as { activity: string }).activity).toBe(`Placed BUY LIMIT 0.1 ${fx.symbol.name} @ 3,950.00 for ${fx.account.accountNumber}`);
    expect(audit.actorAdminId).toBe(fx.trader.id);
  });
});

describe("Manual position", () => {
  const body = (fx: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) => ({ symbolId: fx.symbol.id, side: "BUY", volume: "0.10", openPrice: "3900.00", reason: "phone order", ...extra });
  it("is BROKER_ADMIN only, needs a reason and an open time between the account's opening and now", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { POST } = await import("@/app/api/manage/accounts/[id]/manual-positions/route");
    const p = () => ({ params: Promise.resolve({ id: fx.account.id }) });
    await as(fx.trader);
    expect((await POST(req(body(fx)), p())).status).toBe(403);
    await as(fx.admin);
    expect((await POST(req(body(fx, { reason: "" })), p())).status).toBe(400);
    expect((await POST(req(body(fx, { openedAt: new Date(Date.now() + 3600_000).toISOString() })), p())).status).toBe(400);
    expect((await POST(req(body(fx, { openedAt: new Date(fx.account.createdAt.getTime() - 60_000).toISOString() })), p())).status).toBe(400);
  });
  it("the preview equals what the create books; it is marked manual and no hedge, mirror or coverage row is made", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { POST } = await import("@/app/api/manage/accounts/[id]/manual-positions/route");
    await as(fx.admin);
    const pre = await (await POST(req(body(fx, { dryRun: true })), { params: Promise.resolve({ id: fx.account.id }) })).json();
    expect(pre.refused).toBeNull();
    // BUY 0.10 at 3900 valued at the bid 4000: (4000 - 3900) x 100 x 0.10 = 1000.00
    expect(pre.preview.floatingPnl).toBe("1000.00");
    expect(pre.preview.marginUsedAfter).toBe("390.00");
    const openedAt = new Date(fx.account.createdAt.getTime() + 1).toISOString();   // after the account opened, before now
    const made = await POST(req(body(fx, { openedAt, openedAtSource: "price-lookup" })), { params: Promise.resolve({ id: fx.account.id }) });
    expect(made.status).toBe(201);
    const out = await made.json();
    expect(out.preview.floatingPnl).toBe(pre.preview.floatingPnl);
    expect(out.preview.marginUsedAfter).toBe(pre.preview.marginUsedAfter);
    const pos = await prisma.position.findUniqueOrThrow({ where: { id: out.positionId }, include: { originOrder: true } });
    expect(pos.manual).toBe(true);
    expect(pos.openPrice.toFixed(2)).toBe("3900.00");
    expect(pos.openedAt.toISOString()).toBe(openedAt);
    expect(pos.originOrder.source).toBe("ADMIN");
    expect(await prisma.position.count({ where: { brokerId: fx.broker.id } })).toBe(1);   // no coverage / hedge / mirror leg
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: pos.id, action: "MANUAL_POSITION_ADDED" } });
    expect((audit.newValue as { openedAtSource: string; reason: string }).openedAtSource).toBe("price-lookup");
    expect((audit.newValue as { reason: string }).reason).toBe("phone order");
  });
  it("is refused when it would put the account below stop-out", async () => {
    if (!dbReachable) return;
    const fx = await fixture("100");
    const { POST } = await import("@/app/api/manage/accounts/[id]/manual-positions/route");
    await as(fx.admin);
    const r = await POST(req(body(fx, { openPrice: "4100.00", volume: "1.00" })), { params: Promise.resolve({ id: fx.account.id }) });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe("BELOW_STOP_OUT");
    expect(await prisma.position.count({ where: { accountId: fx.account.id } })).toBe(0);
  });
});

describe("open time from the open price", () => {
  const t = (iso: string) => new Date(iso);
  // bars newest first, as the engine pages them
  const store: Record<string, { bucketStart: Date; low: number; high: number }[]> = {
    H1: [
      { bucketStart: t("2026-11-04T10:00:00Z"), low: 3990, high: 4010 },
      { bucketStart: t("2026-11-04T09:00:00Z"), low: 3970, high: 3995 },
      { bucketStart: t("2026-11-01T09:00:00Z"), low: 3800, high: 3850 },
    ],
    M1: [
      { bucketStart: t("2026-11-04T10:42:00Z"), low: 4005, high: 4010 },
      { bucketStart: t("2026-11-04T10:41:00Z"), low: 3999, high: 4004 },
      { bucketStart: t("2026-11-04T10:05:00Z"), low: 3990, high: 3992 },
    ],
    M5: [],
    D1: [{ bucketStart: t("2026-10-20T00:00:00Z"), low: 3600, high: 3700 }],
  };
  const fetch = async (_s: string, tf: "M1" | "M5" | "H1" | "D1", _limit: number, before: Date | null) =>
    store[tf].filter((b) => !before || b.bucketStart < before);
  const now = t("2026-11-04T10:43:00Z");
  it("a price inside the newest minute bars returns that minute", async () => {
    const { lookupPriceTime } = await import("@/lib/price-time");
    expect(await lookupPriceTime("X", 4002, t("2026-01-01T00:00:00Z"), now, fetch)).toEqual({ at: "2026-11-04T10:41:00.000Z", precision: "minute", timeframe: "M1", series: "bid" });
  });
  it("a price only reached days ago returns the right bucket and its precision", async () => {
    const { lookupPriceTime } = await import("@/lib/price-time");
    expect(await lookupPriceTime("X", 3820, t("2026-01-01T00:00:00Z"), now, fetch)).toMatchObject({ at: "2026-11-01T09:00:00.000Z", precision: "hour" });
    expect(await lookupPriceTime("X", 3650, t("2026-01-01T00:00:00Z"), now, fetch)).toMatchObject({ at: "2026-10-20T00:00:00.000Z", precision: "day" });
  });
  it("a price never reached, or only reached before the account opened, is NOT_FOUND", async () => {
    const { lookupPriceTime } = await import("@/lib/price-time");
    expect(await lookupPriceTime("X", 5000, t("2026-01-01T00:00:00Z"), now, fetch)).toEqual({ at: null, reason: "NOT_FOUND" });
    expect(await lookupPriceTime("X", 3820, t("2026-11-02T00:00:00Z"), now, fetch)).toEqual({ at: null, reason: "NOT_FOUND" });
  });
  it("another broker's account gets 403 / 404, never a lookup", async () => {
    if (!dbReachable) return;
    const a = await fixture();
    const b = await fixture();
    const { GET } = await import("@/app/api/manage/accounts/[id]/manual-positions/price-time/route");
    await as(a.trader);
    expect((await GET(new NextRequest(`https://test.local/x?symbolId=${a.symbol.id}&side=BUY&price=4000`), { params: Promise.resolve({ id: a.account.id }) })).status).toBe(403);
    await as(a.admin);
    expect((await GET(new NextRequest(`https://test.local/x?symbolId=${b.symbol.id}&side=BUY&price=4000`), { params: Promise.resolve({ id: b.account.id }) })).status).toBe(404);
  });
});

describe("client routes say who opened it, never the name", () => {
  it("openedByStaff and manual reach the client shape", async () => {
    const { clientPosition, clientOrder } = await import("@/lib/client-execution");
    const pos = clientPosition({ id: "p", manual: true, originOrder: { source: "ADMIN" }, closedByAdminId: "admin-1" });
    expect(pos.openedByStaff).toBe(true);
    expect(pos.manual).toBe(true);
    expect(pos.closedByAdminId).toBe("staff");
    expect(clientPosition({ id: "q", manual: false, originOrder: { source: "DESKTOP_NATIVE" } }).openedByStaff).toBe(false);
    expect(clientOrder({ id: "o", source: "ADMIN" }).openedByStaff).toBe(true);
  });
});
