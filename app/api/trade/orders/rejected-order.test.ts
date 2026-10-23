import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Rejected-order trace (owner 2026-10-23, SpotBrent investigation): every order request the route refuses before any
// Order row is written leaves a RejectedOrder row, a backoffice-only event and a REJECTED feed row.

vi.mock("@/lib/account-auth", () => ({
  getAccountSession: vi.fn(),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "RejectedOrder" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("rejected-order.test.ts: DB (with the RejectedOrder table) unreachable, skipping");
  }
});

type Fixture = { brokerId: string; accountId: string; accountNumber: string; symbolName: string };
const createdBrokerIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Rejected Order Test ${suffix}`, subdomain: `rotest-${suffix}` } });
  createdBrokerIds.push(broker.id);
  const symbol = await prisma.symbol.create({ data: { name: `RO${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", digits: 2 } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("99.90"), ask: D("100.10") } });
  const accountNumber = `6${suffix.slice(0, 7)}`;
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `RO-${suffix}`, dealingMode: "AUTO" } });
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber, email: `ro-${suffix}@test.local`, passwordHash: "x", fullName: "Rejected Order Test", accountMode: "LIVE", balance: D(1000000) },
  });
  return { brokerId: broker.id, accountId: account.id, accountNumber, symbolName: symbol.name };
}

async function placeOrder(fx: Fixture, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId });
  const { POST } = await import("./route");
  const request = new NextRequest("https://test.local/api/trade/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7", ...headers },
    body: JSON.stringify({ symbol: fx.symbolName, idempotencyKey: `ro-test:${randomUUID()}`, ...body }),
  });
  const response = await POST(request); // outside a request scope the trace is awaited inline (lib/after-response.ts)
  return { status: response.status, json: await response.json() };
}

afterAll(async () => {
  if (dbReachable && createdBrokerIds.length) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.rejectedOrder.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.deal.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where }).catch(() => {});
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "RO" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "RO" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("rejected-order trace (live DB)", () => {
  it("a refused request writes one RejectedOrder row with what was asked, why, when and from where; and a backoffice-only event", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const { publishTradingEvent } = await import("@/lib/nats");
    vi.mocked(publishTradingEvent).mockClear();

    const r = await placeOrder(fx, { symbol: "SPOTBRENTX", side: "BUY", type: "MARKET", volume: "0.10", price: "65.10" });
    expect(r.status).toBe(400);
    const rows = await prisma.rejectedOrder.findMany({ where: { accountId: fx.accountId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerId: fx.brokerId, symbol: "SPOTBRENTX", side: "BUY", volume: "0.10", orderType: "MARKET", reason: "symbol not available for this broker", clientReason: "SYMBOL_NOT_AVAILABLE", platform: "WebTrader", clientIp: "203.0.113.7", source: "WEB" });
    expect(rows[0].requestedAt).toBeInstanceOf(Date);
    const ev = vi.mocked(publishTradingEvent).mock.calls.find(([type]) => type === "OrderRejectedPreTrade");
    expect(ev?.[1]).toMatchObject({ broker_id: fx.brokerId, account_id: fx.accountId, account_number: fx.accountNumber, symbol: "SPOTBRENTX", reason: "symbol not available for this broker", rejected_order_id: rows[0].id });
  });

  it("the refusal's sub-reason (code / reason) is kept; a native terminal's source and platform are recorded", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const r = await placeOrder(fx, { side: "SELL", type: "MARKET", volume: "abc", price: "99.90" }, { "x-client-platform": "DESKTOP_NATIVE", "x-client-build": "futurixglobal-terminal-1.0.94-abc" });
    expect(r.status).toBe(400);
    const row = await prisma.rejectedOrder.findFirstOrThrow({ where: { accountId: fx.accountId } });
    expect(row).toMatchObject({ symbol: fx.symbolName, side: "SELL", volume: "abc", reason: "invalid volume", detail: "INVALID_VOLUME", clientReason: "INVALID_VOLUME", source: "DESKTOP_NATIVE", platform: "Windows terminal 1.0.94" });
  });

  it("a filled order leaves no rejection trace", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const r = await placeOrder(fx, { side: "BUY", type: "MARKET", volume: "0.01", price: "100.10" });
    expect(r.status).toBe(201);
    expect(await prisma.rejectedOrder.count({ where: { accountId: fx.accountId } })).toBe(0);
  });

  it("the Live exposure feed lists the refusal as ORDER_REJECTED with its reason", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const r = await placeOrder(fx, { symbol: "SPOTCRUDEX", side: "SELL", type: "MARKET", volume: "1", price: "61.20" });
    const { getDealerActivityFeedRows } = await import("@/lib/dealer-activity");
    const feed = await getDealerActivityFeedRows(fx.brokerId);
    const row = feed.find((f) => f.action === "ORDER_REJECTED");
    expect(row).toMatchObject({ accountNumber: fx.accountNumber, symbol: "SPOTCRUDEX", side: "SELL", volume: "1", values: { reason: "symbol not available for this broker" } });
    expect(r.json).toMatchObject({ clientReason: "SYMBOL_NOT_AVAILABLE" }); // the client gets the code only
  });
});

// Security re-audit 2026-10-23 (adversarial): who can write a trace, what it records from a hostile request, and how
// many rows one account can write.
describe("rejected-order trace under attack (live DB)", () => {
  it("no session: 401 and no row anywhere", async () => {
    if (!dbReachable) return;
    const { getAccountSession } = await import("@/lib/account-auth");
    vi.mocked(getAccountSession).mockResolvedValue(null);
    const before = await prisma.rejectedOrder.count();
    const { POST } = await import("./route");
    const res = await POST(new NextRequest("https://test.local/api/trade/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: "SPOTBRENTX", side: "BUY", type: "MARKET", volume: "1" }) }));
    expect(res.status).toBe(401);
    expect(await prisma.rejectedOrder.count()).toBe(before);
  });

  it("spoofed IP: x-forwarded-for is never recorded; a malformed x-real-ip is stored as no IP", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    await placeOrder(fx, { symbol: "SPOTBRENTX", side: "BUY", type: "MARKET", volume: "1" }, { "x-real-ip": "", "x-forwarded-for": "6.6.6.6" });
    await placeOrder(fx, { symbol: "SPOTBRENTX", side: "BUY", type: "MARKET", volume: "1" }, { "x-real-ip": "<script>alert(1)</script>" });
    const rows = await prisma.rejectedOrder.findMany({ where: { accountId: fx.accountId } });
    expect(rows.map((r) => r.clientIp)).toEqual([null, null]);
  });

  it("oversized body (1 MB strings) and non-object bodies: the route answers 400, the row is clipped, nothing throws", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const big = "X".repeat(1_000_000);
    const r = await placeOrder(fx, { symbol: big, side: big, type: big, volume: big, price: big });
    expect(r.status).toBe(400);
    const row = await prisma.rejectedOrder.findFirstOrThrow({ where: { accountId: fx.accountId } });
    expect([row.symbol.length, row.side, row.orderType, (row.volume ?? "").length]).toEqual([40, null, null, 30]);
    expect(row.reason.length).toBeLessThanOrEqual(120);

    const { getAccountSession } = await import("@/lib/account-auth");
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId });
    const { POST } = await import("./route");
    for (const body of ['["a",1]', '"text"', "null", "{not json"]) {
      const res = await POST(new NextRequest("https://test.local/api/trade/orders", { method: "POST", headers: { "content-type": "application/json" }, body }));
      expect(res.status).toBe(400);
    }
  });

  it("flood: one account sending 150 refused orders in a minute writes at most 60 rows (and 60 events); the trader still gets every 400", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    // the order rate limit (below) would stop this flood at 100; this test is about the trace's own cap
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { orderBurst: 0 } });
    (await import("@/lib/order-rate-limit")).resetOrderLimitsCache();
    const { publishTradingEvent } = await import("@/lib/nats");
    vi.mocked(publishTradingEvent).mockClear();
    const statuses = new Set<number>();
    for (let i = 0; i < 150; i++) statuses.add((await placeOrder(fx, { symbol: "SPOTBRENTX", side: "BUY", type: "MARKET", volume: "1" })).status);
    expect([...statuses]).toEqual([400]);
    expect(await prisma.rejectedOrder.count({ where: { accountId: fx.accountId } })).toBe(60);
    expect(vi.mocked(publishTradingEvent).mock.calls.filter(([t]) => t === "OrderRejectedPreTrade")).toHaveLength(60);
  }, 120000);
});

// Order rate limit per account (owner 2026-10-23, lib/order-rate-limit.ts), through the real route and the real Redis.
describe("order rate limit on POST /api/trade/orders (live DB)", () => {
  const capped = async (fx: Fixture, burst: number) => {
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { orderBurst: burst, orderPerMinute: 1 } });
    (await import("@/lib/order-rate-limit")).resetOrderLimitsCache();
  };

  it("past the burst: 429 in plain words with Retry-After; one RejectedOrder row per episode, not one per refusal", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    await capped(fx, 3);
    const statuses: number[] = [];
    let last: Awaited<ReturnType<typeof placeOrder>> | null = null;
    for (let i = 0; i < 6; i++) {
      last = await placeOrder(fx, { side: "BUY", type: "MARKET", volume: "0.01", price: "100.10" });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([201, 201, 201, 429, 429, 429]);
    expect(last!.json).toMatchObject({ error: "Too many requests - wait a moment", clientReason: "TOO_MANY_REQUESTS" });
    expect(last!.json.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    const rows = await prisma.rejectedOrder.findMany({ where: { accountId: fx.accountId } });
    expect(rows.map((r) => r.detail)).toEqual(["ORDER_RATE_LIMITED"]);
    expect(await prisma.order.count({ where: { accountId: fx.accountId } })).toBe(3);
  });

  it("a retry of an order already answered (same idempotencyKey) is answered, never refused", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    await capped(fx, 1);
    const key = `rl-retry:${randomUUID()}`;
    const first = await placeOrder(fx, { side: "BUY", type: "MARKET", volume: "0.01", price: "100.10", idempotencyKey: key });
    expect(first.status).toBe(201);
    const retry = await placeOrder(fx, { side: "BUY", type: "MARKET", volume: "0.01", price: "100.10", idempotencyKey: key });
    expect(retry.status).toBe(200); // the replay answers with the existing order itself
    expect(retry.json.id).toBe(first.json.order.id);
    expect((await placeOrder(fx, { side: "BUY", type: "MARKET", volume: "0.01", price: "100.10" })).status).toBe(429);
  });

  it("broker setting 0 turns the cap off", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    await capped(fx, 0);
    for (let i = 0; i < 5; i++) expect((await placeOrder(fx, { side: "BUY", type: "MARKET", volume: "0.01", price: "100.10" })).status).toBe(201);
  });
});
