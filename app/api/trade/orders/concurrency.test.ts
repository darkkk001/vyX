import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// 2026-10-08 hotfix: 11 concurrent MARKET orders on one account returned 500 (10x Postgres 40P01 deadlock, 1x
// "Transaction already closed"). The fill transaction's order.create / position.create take FOR KEY SHARE on the
// Account row through the foreign keys, and chargeCommission then asked for FOR UPDATE: two orders on one account
// each held KEY SHARE and each waited for the other. These tests fire the orders truly in parallel against a real
// Postgres and assert every one fills, the commission is exact, and one idempotency key yields exactly one order.
const session = vi.hoisted(() => ({ current: { accountId: "", brokerId: "" } }));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: async () => session.current }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("orders concurrency.test.ts: DB unreachable, skipping");
  }
});

const createdBrokerIds: string[] = [];

async function createFixture(commissionPerLot = "7.00") {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Conc Test ${suffix}`, subdomain: `conc-${suffix}` } });
  createdBrokerIds.push(broker.id);
  const symbol = await prisma.symbol.create({
    data: { name: `CC${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", digits: 2 },
  });
  await prisma.brokerSymbol.create({
    data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", commissionPerLot: D(commissionPerLot) },
  });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("99.90"), ask: D("100.10") } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `CG-${Math.random().toString(36).slice(2, 10)}`, dealingMode: "AUTO" } });
  const account = await prisma.account.create({
    data: {
      groupId: group.id,
      brokerId: broker.id,
      accountNumber: `7${suffix.slice(0, 7)}`,
      email: `conc-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Concurrency Test Client",
      accountMode: "LIVE",
      balance: D(1000000),
    },
  });
  return { brokerId: broker.id, accountId: account.id, symbolName: symbol.name };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function placeMarket(fx: Fixture, idempotencyKey: string) {
  session.current = { accountId: fx.accountId, brokerId: fx.brokerId };
  const { POST } = await import("./route");
  const request = new NextRequest("https://test.local/api/trade/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.01", price: "100.10", idempotencyKey }),
  });
  try {
    const response = await POST(request);
    return { status: response.status, json: await response.json() };
  } catch (e) {
    return { status: 500, json: { error: String((e as Error)?.message ?? e) } };
  }
}

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where: { brokerId: { in: createdBrokerIds } } }).catch(() => {});
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "CC" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "CC" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("concurrent MARKET orders on one account (live DB)", () => {
  it("8 parallel orders with commission all fill: no deadlock, exact balance, no duplicates", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => placeMarket(fx, `conc:${randomUUID()}`)));
    expect(results.map((r) => r.status + " " + (r.status === 201 ? "" : String(r.json.error).slice(0, 160)))).toEqual(Array(8).fill("201 "));

    const orders = await prisma.order.findMany({ where: { accountId: fx.accountId } });
    const positions = await prisma.position.findMany({ where: { accountId: fx.accountId } });
    const commissions = await prisma.transaction.findMany({ where: { accountId: fx.accountId, type: "COMMISSION" } });
    expect(orders).toHaveLength(8);
    expect(positions).toHaveLength(8);
    expect(commissions).toHaveLength(8);
    // 8 x 0.01 lot x 7.00 = 0.56
    const account = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
    expect(account.balance.toString()).toBe("999999.44");
    for (const p of positions) expect(p.commission.toString()).toBe("0.07");
  }, 60000);

  it("the same idempotency key sent concurrently creates exactly one order and one charge", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const key = `conc-same:${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => placeMarket(fx, key)));
    for (const r of results) expect([200, 201]).toContain(r.status);
    expect(await prisma.order.count({ where: { accountId: fx.accountId } })).toBe(1);
    expect(await prisma.position.count({ where: { accountId: fx.accountId } })).toBe(1);
    expect(await prisma.transaction.count({ where: { accountId: fx.accountId, type: "COMMISSION" } })).toBe(1);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
    expect(account.balance.toString()).toBe("999999.93");
  }, 60000);
});
