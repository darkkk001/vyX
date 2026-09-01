import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// This route reads its session via next/headers (getAdminSession), which
// only works inside a real Next.js request lifecycle, and calls
// prisma.$transaction against the top-level prisma singleton directly --
// unlike lib/mirror.ts's onFill/onClose, there's no injectable tx client
// to wrap the whole test in one rolled-back transaction (see
// lib/mirror.test.ts's own withRollback for that pattern; it doesn't
// apply here). So this test creates real fixtures via the live DB and
// cleans them up itself afterward, rather than relying on a rollback.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
// Avoid a real outbound HTTP call to the gateway on every action.
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("dealing-queue [id] route.test.ts: DB unreachable, skipping");
  }
});

type Fixture = {
  brokerId: string;
  adminId: string;
  accountId: string;
  symbolId: string;
  symbolName: string;
  digits: number;
};

const createdBrokerIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({
    data: { name: `Dealing Queue Test ${suffix}`, subdomain: `dqtest-${suffix}` },
  });
  createdBrokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({
    data: { brokerId: broker.id, email: `dq-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" },
  });
  const symbol = await prisma.symbol.create({
    data: { name: `DQ${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", digits: 2 },
  });
  await prisma.brokerSymbol.create({
    data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" },
  });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10") } });
  const account = await prisma.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `7${suffix.slice(0, 7)}`,
      email: `dq-client-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Dealing Queue Test Client",
      accountType: "LIVE",
      balance: D(10000),
    },
  });
  return { brokerId: broker.id, adminId: admin.id, accountId: account.id, symbolId: symbol.id, symbolName: symbol.name, digits: 2 };
}

async function createPendingOrder(fx: Fixture, opts?: { requestedPrice?: string; side?: "BUY" | "SELL" }) {
  return prisma.order.create({
    data: {
      brokerId: fx.brokerId,
      accountId: fx.accountId,
      symbolId: fx.symbolId,
      side: opts?.side ?? "BUY",
      type: "MARKET",
      volume: D(1),
      requestedPrice: D(opts?.requestedPrice ?? "97.50"), // deliberately far from live (100.00/100.10) -- the whole point
      idempotencyKey: `dq-test:${randomUUID()}`,
      status: "PENDING",
    },
  });
}

async function patch(fx: Fixture, orderId: string, body: Record<string, unknown>) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId });
  const { PATCH } = await import("./route");
  const request = new NextRequest(`https://test.local/api/manage/dealing-queue/${orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await PATCH(request, { params: Promise.resolve({ id: orderId }) });
  return { status: response.status, json: await response.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  // Batched across every test broker created this run, FK-safe order --
  // one broker at a time (the original shape) blew past vitest's default
  // 10s hook timeout once enough tests had each created their own.
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "DQ" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "DQ" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("PATCH /api/manage/dealing-queue/[id] -- ACCEPT/REQUOTE/REJECT (live DB)", () => {
  it("ACCEPT fills at exactly the order's own requestedPrice, never at the live price, with no comparison at all", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const order = await createPendingOrder(fx, { requestedPrice: "97.50" }); // live is 100.00/100.10 -- deliberately far off

    const { status, json } = await patch(fx, order.id, { action: "ACCEPT" });

    expect(status).toBe(200);
    expect(json.status).toBe("FILLED");
    // BUY fills at exactly requestedPrice (spreadMarkup is 0 for this
    // fixture's BrokerSymbol, so no markup shifts it) -- not the live ask.
    expect(json.filledPrice).toBe("97.5");

    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.status).toBe("FILLED");
    expect(updatedOrder.filledPrice?.toString()).toBe("97.5");

    const position = await prisma.position.findUniqueOrThrow({ where: { id: json.positionId } });
    expect(position.openPrice.toString()).toBe("97.5");
  });

  it("ACCEPT ignores a price in the request body entirely -- there is no way to make it fill at anything but requestedPrice", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const order = await createPendingOrder(fx, { requestedPrice: "97.50" });

    const { json } = await patch(fx, order.id, { action: "ACCEPT", price: "150.00" });

    expect(json.filledPrice).toBe("97.5"); // the body's price is simply not read
  });

  it("REQUOTE sets the order to REQUOTED at the dealer-submitted price, and does not create a position", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const order = await createPendingOrder(fx, { requestedPrice: "97.50" });

    const { status, json } = await patch(fx, order.id, { action: "REQUOTE", price: "100.05" });

    expect(status).toBe(200);
    expect(json.status).toBe("REQUOTED");
    expect(json.requotedPrice).toBe("100.05");

    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.status).toBe("REQUOTED");
    expect(updatedOrder.requotedPrice?.toString()).toBe("100.05");
    expect(await prisma.position.findFirst({ where: { originOrderId: order.id } })).toBeNull();
  });

  it("REQUOTE requires a positive price", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const order = await createPendingOrder(fx);

    const { status, json } = await patch(fx, order.id, { action: "REQUOTE", price: "-5" });

    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
    const stillPending = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stillPending.status).toBe("PENDING");
  });

  it("REJECT still works on a fresh PENDING order, unchanged", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const order = await createPendingOrder(fx);

    const { status, json } = await patch(fx, order.id, { action: "REJECT", reason: "Test rejection" });

    expect(status).toBe(200);
    expect(json.status).toBe("REJECTED");
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe("REJECTED");
    expect(updated.rejectionReason).toBe("Test rejection");
  });

  it("REJECT also withdraws an already-REQUOTED order", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const order = await createPendingOrder(fx);
    await patch(fx, order.id, { action: "REQUOTE", price: "100.05" });

    const { status, json } = await patch(fx, order.id, { action: "REJECT", reason: "Withdrawing" });

    expect(status).toBe(200);
    expect(json.status).toBe("REJECTED");
  });

  it("REQUOTE cannot be applied twice -- an already-REQUOTED order can only be withdrawn", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const order = await createPendingOrder(fx);
    await patch(fx, order.id, { action: "REQUOTE", price: "100.05" });

    const { status, json } = await patch(fx, order.id, { action: "REQUOTE", price: "100.06" });

    expect(status).toBe(409);
    expect(json.error).toMatch(/already requoted/i);
  });

  it("ACCEPT cannot be applied to an already-REQUOTED order either", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const order = await createPendingOrder(fx);
    await patch(fx, order.id, { action: "REQUOTE", price: "100.05" });

    const { status, json } = await patch(fx, order.id, { action: "ACCEPT" });

    expect(status).toBe(409);
    expect(json.error).toMatch(/already requoted/i);
  });
});
