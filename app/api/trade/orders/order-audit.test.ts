import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Broker feedback items 14+15 -- these assert payload completeness for
// every order-lifecycle event that previously wrote no AuditLog row at
// all (plain placement, entry/SL/TP modification, the common
// trigger->immediate-fill path) or that only carried bare status/price
// fields with no order number/symbol/side/lots (cancellation). Same
// live-DB-fixture-and-cleanup pattern as
// app/api/manage/dealing-queue/[id]/route.test.ts -- these routes read
// their session via next/headers and call prisma.$transaction against
// the top-level singleton, so there's no injectable tx to roll back.
vi.mock("@/lib/account-auth", () => ({
  getAccountSession: vi.fn(),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("orders order-audit.test.ts: DB unreachable, skipping");
  }
});

type Fixture = { brokerId: string; accountId: string; accountNumber: string; symbolId: string; symbolName: string };

const createdBrokerIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Order Audit Test ${suffix}`, subdomain: `oatest-${suffix}` } });
  createdBrokerIds.push(broker.id);
  const symbol = await prisma.symbol.create({
    data: { name: `OA${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", digits: 2 },
  });
  await prisma.brokerSymbol.create({
    data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" },
  });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("99.90"), ask: D("100.10") } });
  const accountNumber = `8${suffix.slice(0, 7)}`;
  const account = await prisma.account.create({
    data: {
      brokerId: broker.id,
      accountNumber,
      email: `oa-client-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Order Audit Test Client",
      accountType: "LIVE",
      // Symbol.contractSize defaults to 100000 (a plain FOREX-shaped
      // symbol here) -- a high balance keeps checkAccountPreTradeMargin
      // from rejecting the MARKET-fill tests below over margin, which
      // isn't what those tests are about.
      balance: D(1000000),
    },
  });
  return { brokerId: broker.id, accountId: account.id, accountNumber, symbolId: symbol.id, symbolName: symbol.name };
}

function mockSession(fx: Fixture) {
  return import("@/lib/account-auth").then(({ getAccountSession }) =>
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId })
  );
}

async function placeOrder(fx: Fixture, body: Record<string, unknown>) {
  await mockSession(fx);
  const { POST } = await import("./route");
  const request = new NextRequest("https://test.local/api/trade/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: fx.symbolName, idempotencyKey: `oa-test:${randomUUID()}`, ...body }),
  });
  const response = await POST(request);
  return { status: response.status, json: await response.json() };
}

async function patchOrder(fx: Fixture, id: string, body: Record<string, unknown>) {
  await mockSession(fx);
  const { PATCH } = await import("./[id]/route");
  const request = new NextRequest(`https://test.local/api/trade/orders/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await PATCH(request, { params: Promise.resolve({ id }) });
  return { status: response.status, json: await response.json() };
}

async function cancelOrder(fx: Fixture, id: string) {
  await mockSession(fx);
  const { DELETE } = await import("./[id]/route");
  const response = await DELETE(new Request(`https://test.local/api/trade/orders/${id}`), { params: Promise.resolve({ id }) });
  return { status: response.status, json: await response.json() };
}

async function fillOrder(fx: Fixture, id: string, price: string) {
  await mockSession(fx);
  const { POST } = await import("./[id]/fill/route");
  const request = new NextRequest(`https://test.local/api/trade/orders/${id}/fill`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ price }),
  });
  const response = await POST(request, { params: Promise.resolve({ id }) });
  return { status: response.status, json: await response.json() };
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
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "OA" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "OA" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("order-lifecycle audit payload completeness (live DB)", () => {
  it("placing a resting LIMIT order writes ORDER_PLACED with entry price, SL, TP, and order identity", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();

    const { status, json } = await placeOrder(fx, { side: "BUY", type: "LIMIT", volume: "0.10", price: "90.00", slPrice: "85.00", tpPrice: "95.00" });
    expect(status).toBe(201);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "ORDER_PLACED", entityId: json.id } });
    const after = audit.newValue as Record<string, unknown>;
    expect(after.orderNumber).toBe(json.id);
    expect(after.accountNumber).toBe(fx.accountNumber);
    expect(after.symbol).toBe(fx.symbolName);
    expect(after.side).toBe("BUY");
    expect(after.lots).toBe("0.1");
    expect(after.requestedPrice).toBe("90.00");
    expect(after.slPrice).toBe("85.00");
    expect(after.tpPrice).toBe("95.00");
    expect(after.status).toBe("PENDING");
  });

  it("an immediate MARKET fill (no dealing queue) writes ORDER_FILLED with requested vs filled price", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();

    const { status, json } = await placeOrder(fx, { side: "BUY", type: "MARKET", volume: "0.01", price: "100.10" });
    expect(status).toBe(201);
    const positionId = json.position.id;

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "ORDER_FILLED", entityId: positionId } });
    const before = audit.oldValue as Record<string, unknown>;
    const after = audit.newValue as Record<string, unknown>;
    expect(before.orderNumber).toBe(json.order.id);
    expect(before.accountNumber).toBe(fx.accountNumber);
    expect(before.symbol).toBe(fx.symbolName);
    expect(before.side).toBe("BUY");
    expect(before.lots).toBe("0.01");
    expect(before.requestedPrice).toBe("100.10");
    expect(after.status).toBe("FILLED");
    expect(after.filledPrice).toBeTruthy();
  });

  it("PATCH modifying SL writes ORDER_MODIFIED with old -> new for only the changed field", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const placed = await placeOrder(fx, { side: "BUY", type: "LIMIT", volume: "0.10", price: "90.00" });
    const orderId = placed.json.id;

    const { status } = await patchOrder(fx, orderId, { slPrice: "85.00" });
    expect(status).toBe(200);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "ORDER_MODIFIED", entityId: orderId } });
    const before = audit.oldValue as Record<string, unknown>;
    const after = audit.newValue as Record<string, unknown>;
    expect(before.orderNumber).toBe(orderId);
    expect(before.symbol).toBe(fx.symbolName);
    expect(before.slPrice).toBeNull();
    expect(after.slPrice).toBe("85.00");
    // The untouched requestedPrice shouldn't be claimed as "changed" here.
    expect(before.requestedPrice).toBeUndefined();
    expect(after.requestedPrice).toBeUndefined();
  });

  it("cancelling a resting order writes an audit row with cancelledBy CLIENT and a cancelledAt timestamp", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const placed = await placeOrder(fx, { side: "SELL", type: "LIMIT", volume: "0.10", price: "110.00" });
    const orderId = placed.json.id;

    const { status } = await cancelOrder(fx, orderId);
    expect(status).toBe(200);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "TRADER_CANCELLED_PENDING_ORDER", entityId: orderId } });
    const before = audit.oldValue as Record<string, unknown>;
    const after = audit.newValue as Record<string, unknown>;
    expect(before.orderNumber).toBe(orderId);
    expect(before.side).toBe("SELL");
    expect(before.status).toBe("PENDING");
    expect(after.status).toBe("CANCELLED");
    expect(after.cancelledBy).toBe("CLIENT");
    expect(typeof after.cancelledAt).toBe("string");
  });

  it("a pending order's trigger firing (no dealing queue) writes ORDER_TRIGGERED_AND_FILLED with requested, trigger, and filled prices all distinct", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const placed = await placeOrder(fx, { side: "BUY", type: "LIMIT", volume: "0.01", price: "99.00" });
    const orderId = placed.json.id;

    // Re-tick the fixture's LivePrice immediately before filling --
    // checkPriceFreshness (lib/risk.ts) rejects anything older than 3s,
    // and createFixture+placeOrder's own sequential awaited writes
    // (several round trips to the real Neon DB, not a local Postgres)
    // can already eat past that budget before this line even runs.
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D("99.90"), ask: D("100.10"), tickAt: new Date() } });

    // Live ask is 100.10 -- the trigger fires later, at (close to) the
    // live price, not at the order's own original limit price.
    const { status, json } = await fillOrder(fx, orderId, "100.10");
    expect(status).toBe(200);
    const positionId = json.position.id;

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "ORDER_TRIGGERED_AND_FILLED", entityId: positionId } });
    const before = audit.oldValue as Record<string, unknown>;
    const after = audit.newValue as Record<string, unknown>;
    expect(before.orderNumber).toBe(orderId);
    expect(before.accountNumber).toBe(fx.accountNumber);
    expect(before.requestedPrice).toBe("99");
    expect(after.triggerPrice).toBe("100.10");
    expect(after.filledPrice).toBeTruthy();
    expect(after.status).toBe("FILLED");
  });
});
