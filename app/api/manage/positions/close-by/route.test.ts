import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Dealer Close By (backoffice 1.0.19): the real route against a live DB, with money. Both legs close at ONE mid price
// through the audited admin close, atomically; a leg of another client / another broker is refused.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/mirror", () => ({ onClose: vi.fn().mockResolvedValue(undefined), onFillPosition: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("manage close-by route.test.ts: DB unreachable, skipping");
  }
});

type Fixture = { brokerId: string; adminId: string; accountId: string; otherAccountId: string; symbolId: string; symbolName: string };
const createdBrokerIds: string[] = [];
const createdSymbolNames: string[] = [];

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Dealer CloseBy ${suffix}`, subdomain: `dcb-${suffix}`, dealingModeAt: null } });
  createdBrokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `dcb-${suffix}@test.local`, passwordHash: "x", role: "MANAGER", extraPermissions: ["CLIENT_TRADING"] } });
  const symbol = await prisma.symbol.create({ data: { name: `DC${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  createdSymbolNames.push(symbol.name);
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `DCB-${suffix}`, dealingMode: "AUTO" } });
  const mk = (n: string) =>
    prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: `${n}${suffix.slice(0, 7)}`, email: `dcb-${n}-${suffix}@test.local`, passwordHash: "x", fullName: `Client ${n}`, accountMode: "LIVE", balance: D(10000) } });
  const [acc, other] = await Promise.all([mk("6"), mk("5")]);
  return { brokerId: broker.id, adminId: admin.id, accountId: acc.id, otherAccountId: other.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function open(fx: Fixture, side: "BUY" | "SELL", volume: string, openPrice: string, accountId = fx.accountId) {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side, type: "MARKET", volume: D(volume), requestedPrice: D(openPrice), idempotencyKey: `dcb:${randomUUID()}`, status: "FILLED", filledPrice: D(openPrice), filledAt: new Date() },
  });
  return prisma.position.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: order.id, side, volume: D(volume), openPrice: D(openPrice) } });
}

async function dealerCloseBy(fx: Fixture, body: Record<string, unknown>, brokerId = fx.brokerId) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, brokerId, role: "MANAGER" } as never);
  const { POST } = await import("@/app/api/manage/positions/close-by/route");
  const res = await POST(new NextRequest("https://test.local/api/manage/positions/close-by", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}

const balance = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).balance;

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where }).catch(() => {});
    await prisma.adminUser.deleteMany({ where }).catch(() => {});
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } }).catch(() => {});
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: createdSymbolNames } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: createdSymbolNames } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("POST /api/manage/positions/close-by (dealer)", () => {
  it("closes the smaller volume on both legs at one mid price, audited, the larger keeps the rest", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const buy = await open(fx, "BUY", "0.30", "90.00");
    const sell = await open(fx, "SELL", "0.10", "110.00");
    const before = await balance(fx.accountId);

    const res = await dealerCloseBy(fx, { positionId: buy.id, againstPositionId: sell.id });
    expect(res.status).toBe(200);
    expect(res.json.closePrice).toBe("100.05");   // mid of 100.00 / 100.10
    expect(res.json.closeVolume).toBe("0.1");

    const [b2, s2] = await Promise.all([prisma.position.findUniqueOrThrow({ where: { id: buy.id } }), prisma.position.findUniqueOrThrow({ where: { id: sell.id } })]);
    expect(b2.status).toBe("OPEN");
    expect(b2.volume.toString()).toBe("0.2");
    expect(s2.status).toBe("CLOSED");
    expect(s2.closedByAdminId).toBe(fx.adminId);
    // BUY 0.1 @ 90 -> 100.05 = +1.005 ; SELL 0.1 @ 110 -> 100.05 = +0.995 ; total +2.00
    expect((await balance(fx.accountId)).sub(before).toString()).toBe("2");
    const audits = await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "MANUAL_POSITION_CLOSE", actorAdminId: fx.adminId } });
    expect(audits).toBe(2);
  });

  it("refuses two positions of different clients", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const buy = await open(fx, "BUY", "0.10", "90.00");
    const sell = await open(fx, "SELL", "0.10", "110.00", fx.otherAccountId);
    const res = await dealerCloseBy(fx, { positionId: buy.id, againstPositionId: sell.id });
    expect(res.status).toBe(404);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: buy.id } })).status).toBe("OPEN");
  });

  it("refuses another broker's position", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const buy = await open(fx, "BUY", "0.10", "90.00");
    const sell = await open(fx, "SELL", "0.10", "110.00");
    const res = await dealerCloseBy(fx, { positionId: buy.id, againstPositionId: sell.id }, "some-other-broker");
    expect(res.status).toBe(404);
  });

  it("refuses same-side positions and a stale price, nothing moves", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const b1 = await open(fx, "BUY", "0.10", "90.00");
    const b2 = await open(fx, "BUY", "0.10", "95.00");
    const same = await dealerCloseBy(fx, { positionId: b1.id, againstPositionId: b2.id });
    expect(same.status).toBe(400);
    const sell = await open(fx, "SELL", "0.10", "110.00");
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { tickAt: new Date(Date.now() - 10 * 60_000) } });
    const before = await balance(fx.accountId);
    const stale = await dealerCloseBy(fx, { positionId: b1.id, againstPositionId: sell.id });
    expect(stale.status).toBe(400);
    expect((await balance(fx.accountId)).equals(before)).toBe(true);
  });

  it("a MANAGER-less session is forbidden", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, brokerId: fx.brokerId, role: "SUPPORT" } as never);
    const { POST } = await import("@/app/api/manage/positions/close-by/route");
    const res = await POST(new NextRequest("https://test.local/api/manage/positions/close-by", { method: "POST", body: "{}" }));
    expect(res.status).toBe(403);
  });
});
