import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Audit 2026-09-24 (money): every alternative fill path runs the same pre-trade margin gate as a direct order
// (lib/margin.ts checkAccountPreTradeMargin):
//   - dealer ACCEPT            app/api/manage/dealing-queue/[id]
//   - client accepts a requote app/api/trade/orders/[id]/requote-response
//   - desk-off auto-flush      app/api/manage/dealing-desk-toggle
// and the desk-off flush now calls the auto-hedge hook on the fills it makes. BOOK / coverage orders are NOT
// gated on purpose: they open only on the broker's own coverage account (0 balance by design).
// Real fixtures on the local scratch DB, own cleanup (same shape as route.test.ts next to this file).
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("margin-gate.test.ts: DB unreachable, skipping");
  }
});

const createdBrokerIds: string[] = [];
const createdSymbolNames: string[] = [];

type Fx = { brokerId: string; adminId: string; groupId: string; symbolId: string; symbolName: string };

// 1 lot = 100,000 x ~100 / 100 leverage = ~100,000 margin. A 100 balance cannot carry it; 1,000,000 can.
async function createBroker(opts?: { groupType?: "DEALING" | "LP"; dealingMode?: "AUTO" | "INHERIT" }): Promise<Fx> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Margin Gate Test ${suffix}`, subdomain: `mgtest-${suffix}` } });
  createdBrokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `mg-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.create({ data: { name: `MG${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", digits: 2 } });
  createdSymbolNames.push(symbol.name);
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10") } });
  const group = await prisma.group.create({
    data: { brokerId: broker.id, name: `MG-${suffix}`, dealingMode: opts?.dealingMode ?? "AUTO", groupType: opts?.groupType ?? "DEALING" },
  });
  return { brokerId: broker.id, adminId: admin.id, groupId: group.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function createAccount(fx: Fx, balance: number) {
  const n = `8${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "1")}`;
  return prisma.account.create({
    data: { groupId: fx.groupId, brokerId: fx.brokerId, accountNumber: n, email: `mg-${n}-${randomUUID().slice(0, 6)}@test.local`, passwordHash: "x", fullName: "Margin Gate Client", accountMode: "LIVE", balance: D(balance) },
  });
}

async function queuedOrder(fx: Fx, accountId: string, opts?: { side?: "BUY" | "SELL"; status?: "PENDING" | "REQUOTED" }) {
  return prisma.order.create({
    data: {
      brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: opts?.side ?? "BUY", type: "MARKET", volume: D(1),
      requestedPrice: D("100.10"), requotedPrice: opts?.status === "REQUOTED" ? D("100.20") : null,
      idempotencyKey: `mg-test:${randomUUID()}`, status: opts?.status ?? "PENDING",
    },
  });
}

async function asAdmin(fx: Fx) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId });
}

async function dealerAction(fx: Fx, orderId: string, body: Record<string, unknown>) {
  await asAdmin(fx);
  const { PATCH } = await import("./route");
  const res = await PATCH(new NextRequest(`https://test.local/api/manage/dealing-queue/${orderId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: orderId }) });
  return { status: res.status, json: await res.json() };
}

async function requoteAccept(fx: Fx, accountId: string, orderId: string) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId: fx.brokerId } as never);
  const { POST } = await import("@/app/api/trade/orders/[id]/requote-response/route");
  const res = await POST(new NextRequest(`https://test.local/api/trade/orders/${orderId}/requote-response`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: true }) }), { params: Promise.resolve({ id: orderId }) });
  return { status: res.status, json: await res.json() };
}

async function deskOff(fx: Fx) {
  await asAdmin(fx);
  const { PATCH } = await import("@/app/api/manage/dealing-desk-toggle/route");
  const res = await PATCH(new NextRequest("https://test.local/api/manage/dealing-desk-toggle", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dealerOn: false }) }));
  return { status: res.status, json: await res.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.broker.updateMany({ where: { id: { in: createdBrokerIds } }, data: { coverageAccountId: null } }).catch(() => {});
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.group.deleteMany({ where }).catch(() => {});
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: createdSymbolNames } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: createdSymbolNames } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("dealer ACCEPT runs the pre-trade margin gate", () => {
  it("refuses an order the account cannot margin: 400, order stays PENDING, no position", async () => {
    if (!dbReachable) return;
    const fx = await createBroker();
    const acc = await createAccount(fx, 100);
    const order = await queuedOrder(fx, acc.id);
    const { status, json } = await dealerAction(fx, order.id, { action: "ACCEPT", fillMode: "MARKET" });
    expect(status).toBe(400);
    expect(["INSUFFICIENT_MARGIN", "INSUFFICIENT_BALANCE"]).toContain(json.error);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING");
    expect(await prisma.position.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it("fills the same order on a funded account", async () => {
    if (!dbReachable) return;
    const fx = await createBroker();
    const acc = await createAccount(fx, 1_000_000);
    const order = await queuedOrder(fx, acc.id);
    const { status, json } = await dealerAction(fx, order.id, { action: "ACCEPT", fillMode: "MARKET" });
    expect(status).toBe(200);
    expect(json.status).toBe("FILLED");
    // MARKET = the live ask for a BUY (100.10), not the requested price
    expect(json.filledPrice).toBe("100.1");
  });

  it("an order that does not raise used margin (a full hedge at a hedged margin % below 200) passes even when the account is short", async () => {
    if (!dbReachable) return;
    const fx = await createBroker();
    // 50%: a fully hedged pair costs half of one lot's margin, less than the open BUY alone (MT5 rule, lib/margin.ts)
    await prisma.brokerSymbol.updateMany({ where: { brokerId: fx.brokerId, symbolId: fx.symbolId }, data: { hedgedMarginPct: D(50) } });
    const acc = await createAccount(fx, 100);
    const open = await queuedOrder(fx, acc.id, { side: "BUY" });
    await prisma.order.update({ where: { id: open.id }, data: { status: "FILLED", filledPrice: D("100.10"), filledAt: new Date() } });
    await prisma.position.create({ data: { brokerId: fx.brokerId, accountId: acc.id, symbolId: fx.symbolId, originOrderId: open.id, side: "BUY", volume: D(1), openPrice: D("100.10"), bookType: "B_BOOK" } });
    const hedge = await queuedOrder(fx, acc.id, { side: "SELL" });
    const { status, json } = await dealerAction(fx, hedge.id, { action: "ACCEPT", fillMode: "MARKET" });
    expect(status).toBe(200);
    expect(json.status).toBe("FILLED");
  });
});

describe("client accepting a dealer requote runs the pre-trade margin gate", () => {
  it("refuses on an under-margined account: 400, order stays REQUOTED, no position", async () => {
    if (!dbReachable) return;
    const fx = await createBroker();
    const acc = await createAccount(fx, 100);
    const order = await queuedOrder(fx, acc.id, { status: "REQUOTED" });
    const { status, json } = await requoteAccept(fx, acc.id, order.id);
    expect(status).toBe(400);
    expect(["INSUFFICIENT_MARGIN", "INSUFFICIENT_BALANCE"]).toContain(json.error);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REQUOTED");
    expect(await prisma.position.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it("fills on a funded account at the requoted price", async () => {
    if (!dbReachable) return;
    const fx = await createBroker();
    const acc = await createAccount(fx, 1_000_000);
    const order = await queuedOrder(fx, acc.id, { status: "REQUOTED" });
    const { status, json } = await requoteAccept(fx, acc.id, order.id);
    expect(status).toBe(200);
    expect(json.filledPrice).toBe("100.2");
  });
});

describe("desk turned off: the auto-flush runs the margin gate and auto-hedges what it fills", () => {
  it("skips the under-margined order (left PENDING, reason given), fills the funded one and hedges it", async () => {
    if (!dbReachable) return;
    // a DEALING-type group at INHERIT: queued while the desk reviews, flushed when it is turned off
    const fx = await createBroker({ groupType: "DEALING", dealingMode: "INHERIT" });
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { autoHedgeAt: new Date(), dealingDeskAutoFillAt: null } });
    const poor = await createAccount(fx, 100);
    const rich = await createAccount(fx, 1_000_000);
    const poorOrder = await queuedOrder(fx, poor.id);
    const richOrder = await queuedOrder(fx, rich.id);

    const { status, json } = await deskOff(fx);
    expect(status).toBe(200);
    const byId = new Map((json.flushed as { orderId: string; status: string; reason?: string }[]).map((r) => [r.orderId, r]));

    expect(byId.get(poorOrder.id)?.status).toBe("skipped");
    expect(["INSUFFICIENT_MARGIN", "INSUFFICIENT_BALANCE"]).toContain(byId.get(poorOrder.id)?.reason);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: poorOrder.id } })).status).toBe("PENDING");
    expect(await prisma.position.count({ where: { accountId: poor.id } })).toBe(0);

    expect(byId.get(richOrder.id)?.status).toBe("filled");
    const pos = await prisma.position.findFirstOrThrow({ where: { accountId: rich.id } });
    expect(pos.covered).toBe(true); // the auto-hedge hook ran on the flushed fill
    const broker = await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerId }, select: { coverageAccountId: true } });
    expect(broker.coverageAccountId).toBeTruthy();
    const leg = await prisma.position.findFirst({ where: { accountId: broker.coverageAccountId!, symbolId: fx.symbolId, status: "OPEN" } });
    expect(leg?.side).toBe("BUY");
    expect(leg?.volume.toString()).toBe("1");
  });
});
