import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Closes respect DEALER mode (docs/CLOSES-RESPECT-DEALER-MODE.md) -- the whole loop against a
// live DB: a client close on a dealer-managed account becomes a queued close Order and locks
// the position (no money moves); the dealer's ACCEPT closes it at the dealer's price (money
// moves exactly as a direct close would), REJECT unlocks it, a second close while one is pending
// is refused, a partial close queues + closes partially, bulk fans out one order per position,
// the risk monitor cancels a pending close when SL / TP closes the position first, and the
// desk-off flush executes pending closes. Same fixture / cleanup discipline as route.test.ts.
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
    dbReachable = false;
    console.warn("queued-close.test.ts: DB unreachable, skipping");
  }
});

type Fixture = { brokerId: string; adminId: string; accountId: string; symbolId: string; symbolName: string };
const createdBrokerIds: string[] = [];

async function createFixture(opts?: { dealerOn?: boolean }): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({
    // the dealer desk is ON (dealingDeskAutoFillAt null); queueing is decided by the account's group category below
    // (Phase 2 batch 2 routing rule: DEALING queues while the desk is on, B_BOOK never does)
    data: { name: `Queued Close Test ${suffix}`, subdomain: `qctest-${suffix}`, dealingDeskAutoFillAt: null },
  });
  createdBrokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `qc-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.create({ data: { name: `QC${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  // dealerOn (default) = a DEALING DESK group, queued while the desk is on; dealerOn: false = a B_BOOK group, never queued
  const _g0 = await prisma.group.create({
    data: { brokerId: broker.id, name: `TG-${Math.random().toString(36).slice(2, 10)}`, category: opts?.dealerOn === false ? "B_BOOK" : "DEALING" },
  });
  const account = await prisma.account.create({
    data: { groupId: _g0.id, brokerId: broker.id, accountNumber: `8${suffix.slice(0, 7)}`, email: `qc-client-${suffix}@test.local`, passwordHash: "x", fullName: "Queued Close Client", accountMode: "LIVE", balance: D(10000) },
  });
  return { brokerId: broker.id, adminId: admin.id, accountId: account.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function openPosition(fx: Fixture, opts?: { side?: "BUY" | "SELL"; volume?: string; openPrice?: string; sl?: string; tp?: string }) {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: opts?.side ?? "BUY", type: "MARKET", volume: D(opts?.volume ?? "1.00"), requestedPrice: D(opts?.openPrice ?? "90.00"), idempotencyKey: `qc-open:${randomUUID()}`, status: "FILLED", filledPrice: D(opts?.openPrice ?? "90.00"), filledAt: new Date() },
  });
  return prisma.position.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side: opts?.side ?? "BUY", volume: D(opts?.volume ?? "1.00"), openPrice: D(opts?.openPrice ?? "90.00"), slPrice: opts?.sl ? D(opts.sl) : null, tpPrice: opts?.tp ? D(opts.tp) : null },
  });
}

async function refreshPrice(fx: Fixture, bid = "100.00", ask = "100.10") {
  await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D(bid), ask: D(ask), tickAt: new Date() } });
}

async function clientClose(fx: Fixture, positionId: string, body: Record<string, unknown>) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
  const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
  const request = new NextRequest(`https://test.local/api/trade/positions/${positionId}/close`, { method: "POST", headers: { "content-type": "application/json", "x-client-platform": "DESKTOP_NATIVE" }, body: JSON.stringify(body) });
  const response = await POST(request, { params: Promise.resolve({ id: positionId }) });
  return { status: response.status, json: await response.json() };
}

async function clientBulk(fx: Fixture, body: Record<string, unknown>) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
  const { POST } = await import("@/app/api/trade/positions/close-bulk/route");
  const request = new NextRequest("https://test.local/api/trade/positions/close-bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await POST(request);
  return { status: response.status, json: await response.json() };
}

async function clientCloseBy(fx: Fixture, positionId: string, againstPositionId: string) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
  const { POST } = await import("@/app/api/trade/positions/close-by/route");
  const request = new NextRequest("https://test.local/api/trade/positions/close-by", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ positionId, againstPositionId }) });
  const response = await POST(request);
  return { status: response.status, json: await response.json() };
}

async function dealer(fx: Fixture, orderId: string, body: Record<string, unknown>) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
  const { PATCH } = await import("./route");
  const request = new NextRequest(`https://test.local/api/manage/dealing-queue/${orderId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await PATCH(request, { params: Promise.resolve({ id: orderId }) });
  return { status: response.status, json: await response.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.updateMany({ where, data: { closePendingOrderId: null } });
    await prisma.order.updateMany({ where, data: { closesPositionId: null } });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.group.deleteMany({ where }).catch(() => {});
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.group.deleteMany({ where: { brokerId: { in: createdBrokerIds } } }).catch(() => {});
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "QC" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "QC" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("closes respect DEALER mode (live DB)", () => {
  it("a client close on a dealer-managed account is QUEUED and locks the position -- nothing closes, no money moves", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx);
    await refreshPrice(fx);
    const { status, json } = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(status).toBe(202);
    expect(json.queued).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: json.order.id } });
    expect(order.status).toBe("PENDING");
    expect(order.type).toBe("MARKET");
    expect(order.closesPositionId).toBe(pos.id);
    expect(order.closeVolume?.toString()).toBe("1");
    expect(order.side).toBe("BUY"); // the position's own side
    expect(order.source).toBe("DESKTOP_NATIVE");
    const locked = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(locked.status).toBe("OPEN");
    expect(locked.closePendingOrderId).toBe(order.id);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
    expect(account.balance.toString()).toBe("10000");
    expect(await prisma.transaction.count({ where: { accountId: fx.accountId } })).toBe(0);
    // it is in the dealer's queue
    const { GET } = await import("@/app/api/manage/dealing-queue/route");
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
    const rows = (await (await GET()).json()).rows as { id: string; kind: string; closesTicket: number | null; volume: string }[];
    const row = rows.find((r) => r.id === order.id);
    expect(row?.kind).toBe("CLOSE");
    expect(row?.closesTicket).toBe(locked.ticket);
  });

  it("a second close while one is pending is refused with CLOSE_PENDING", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx);
    await refreshPrice(fx);
    const first = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(first.status).toBe(202);
    const second = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("CLOSE_PENDING");
    expect(second.json.orderId).toBe(first.json.order.id);
  });

  it("dealer ACCEPT closes the position at the requested price: realized P&L, ledger row, order FILLED, lock released", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, { openPrice: "90.00", volume: "2.00" });
    await refreshPrice(fx);
    const q = await clientClose(fx, pos.id, { closePrice: "100.00" });
    const { status, json } = await dealer(fx, q.json.order.id, { action: "ACCEPT" });
    expect(status).toBe(200);
    expect(json.status).toBe("FILLED");
    expect(json.closed).toBe(true);
    expect(json.closePrice).toBe("100");
    const closed = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closePrice?.toString()).toBe("100");
    expect(closed.realizedPnl?.toString()).toBe("20"); // (100 - 90) * 2 lots * contract 1
    expect(closed.closePendingOrderId).toBeNull();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: q.json.order.id } });
    expect(order.status).toBe("FILLED");
    expect(order.filledPrice?.toString()).toBe("100");
    const account = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
    expect(account.balance.toString()).toBe("10020");
    const tx = await prisma.transaction.findFirst({ where: { accountId: fx.accountId, type: "TRADE_PNL" } });
    expect(tx?.amount.toString()).toBe("20");
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "DEALING_CLOSE_ACCEPTED" } })).toBe(1);
  });

  it("dealer ACCEPT at MARKET closes on the close side of the live price (a BUY closes at bid)", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, { openPrice: "90.00" });
    await refreshPrice(fx, "101.00", "101.20");
    const q = await clientClose(fx, pos.id, { closePrice: "101.00" });
    const { status, json } = await dealer(fx, q.json.order.id, { action: "ACCEPT", fillMode: "MARKET" });
    expect(status).toBe(200);
    expect(json.closePrice).toBe("101"); // bid, not ask
  });

  it("dealer REJECT leaves the position open and unlocked", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx);
    await refreshPrice(fx);
    const q = await clientClose(fx, pos.id, { closePrice: "100.00" });
    const { status } = await dealer(fx, q.json.order.id, { action: "REJECT", reason: "not now" });
    expect(status).toBe(200);
    const p = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(p.status).toBe("OPEN");
    expect(p.closePendingOrderId).toBeNull();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: q.json.order.id } })).status).toBe("REJECTED");
    // and the client can ask again
    const again = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(again.status).toBe(202);
  });

  it("a PARTIAL close queues with closeVolume and closes only that much on ACCEPT", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, { volume: "1.00", openPrice: "90.00" });
    await refreshPrice(fx);
    const q = await clientClose(fx, pos.id, { closePrice: "100.00", volume: "0.40" });
    expect(q.status).toBe(202);
    expect(q.json.closeVolume).toBe("0.4");
    const { status } = await dealer(fx, q.json.order.id, { action: "ACCEPT" });
    expect(status).toBe(200);
    const p = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(p.status).toBe("OPEN");
    expect(p.volume.toString()).toBe("0.6");
    expect(p.closePendingOrderId).toBeNull();
    const account = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
    expect(account.balance.toString()).toBe("10004"); // (100-90) * 0.4
  });

  it("bulk close on a dealer-managed account queues one close order per position", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const a = await openPosition(fx); const b = await openPosition(fx, { side: "SELL" });
    await refreshPrice(fx);
    const { status, json } = await clientBulk(fx, { scope: "ALL" });
    expect(status).toBe(202);
    expect(json.queued).toBe(2);
    expect(json.successful).toBe(0);
    for (const id of [a.id, b.id]) {
      const p = await prisma.position.findUniqueOrThrow({ where: { id } });
      expect(p.status).toBe("OPEN");
      expect(p.closePendingOrderId).not.toBeNull();
    }
    expect(await prisma.order.count({ where: { brokerId: fx.brokerId, closesPositionId: { in: [a.id, b.id] }, status: "PENDING" } })).toBe(2);
  });

  it("close-by on a dealer-managed account queues BOTH legs", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const a = await openPosition(fx, { side: "BUY", volume: "1.00" }); const b = await openPosition(fx, { side: "SELL", volume: "0.40" });
    await refreshPrice(fx);
    const { status, json } = await clientCloseBy(fx, a.id, b.id);
    expect(status).toBe(202);
    expect(json.queued).toBe(true);
    expect(json.closeVolume).toBe("0.4");
    const oa = await prisma.order.findUniqueOrThrow({ where: { id: json.orderAId } });
    const ob = await prisma.order.findUniqueOrThrow({ where: { id: json.orderBId } });
    expect(oa.closeVolume?.toString()).toBe("0.4");
    expect(ob.closeVolume?.toString()).toBe("0.4");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: a.id } })).closePendingOrderId).toBe(oa.id);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: b.id } })).closePendingOrderId).toBe(ob.id);
  });

  it("SL / TP closes a locked position immediately and retires the queued close (stage 4)", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, { openPrice: "90.00", tp: "100.00" });
    await refreshPrice(fx, "99.00", "99.10");
    const q = await clientClose(fx, pos.id, { closePrice: "99.00" });
    expect(q.status).toBe(202);
    // the market runs through the take profit while the close waits for the dealer
    await refreshPrice(fx, "100.50", "100.60");
    const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
    const r = await evaluateAccountRisk(fx.accountId);
    expect(r.slTpClosed).toContain(pos.id);
    const p = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(p.status).toBe("CLOSED");
    expect(p.closePrice?.toString()).toBe("100.5");
    expect(p.closePendingOrderId).toBeNull();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: q.json.order.id } });
    expect(order.status).toBe("CANCELLED");
    expect(order.rejectionReason).toBe("position closed by take profit");
    // the dealer acting on the stale queue row now gets a clean 409, nothing double-closes
    const late = await dealer(fx, order.id, { action: "ACCEPT" });
    expect(late.status).toBe(409);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } })).balance.toString()).toBe("10010.5");
  });

  it("dealer ACCEPT on a close whose position was closed meanwhile cancels the order, never double-closes", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, { openPrice: "90.00" });
    await refreshPrice(fx);
    const q = await clientClose(fx, pos.id, { closePrice: "100.00" });
    // something else closes it first (an admin / another path) without going through cancelPendingClose
    await prisma.position.update({ where: { id: pos.id }, data: { status: "CLOSED", closePrice: D("95.00"), realizedPnl: D("5"), closedAt: new Date() } });
    const { status, json } = await dealer(fx, q.json.order.id, { action: "ACCEPT" });
    expect(status).toBe(409);
    expect(String(json.error)).toContain("already closed");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: q.json.order.id } });
    expect(order.status).toBe("CANCELLED");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).closePendingOrderId).toBeNull();
    expect(await prisma.transaction.count({ where: { accountId: fx.accountId } })).toBe(0);
  });

  it("desk OFF flushes a queued close: executed at the live close-side price, lock released (stage 8)", async () => {
    if (!dbReachable) return;
    // a DEALING-type group at INHERIT: queues while the desk is on, auto-fills once the desk is off
    const fx = await createFixture({ dealerOn: false });
    const group = await prisma.group.create({ data: { brokerId: fx.brokerId, name: "Dealing", groupType: "DEALING", category: "DEALING" } });
    await prisma.account.update({ where: { id: fx.accountId }, data: { groupId: group.id } });
    const pos = await openPosition(fx, { openPrice: "90.00", volume: "1.00" });
    await refreshPrice(fx, "100.00", "100.10");
    const q = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(q.status).toBe(202);
    await refreshPrice(fx, "102.00", "102.10");
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
    const { PATCH: toggle } = await import("@/app/api/manage/dealing-desk-toggle/route");
    const res = await toggle(new NextRequest("https://test.local/api/manage/dealing-desk-toggle", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dealerOn: false }) }));
    expect(res.status).toBe(200);
    const flushed = (await res.json()).flushed as { orderId: string; status: string; reason?: string }[];
    expect(flushed.find((f) => f.orderId === q.json.order.id)?.status).toBe("filled");
    const p = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(p.status).toBe("CLOSED");
    expect(p.closePrice?.toString()).toBe("102"); // bid for a BUY, the live price at flush time
    expect(p.closePendingOrderId).toBeNull();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: q.json.order.id } })).status).toBe("FILLED");
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "DEALING_DESK_AUTO_FLUSHED_CLOSE" } })).toBe(1);
  });

  it("with dealer mode OFF the same close executes immediately, as before", async () => {
    if (!dbReachable) return;
    const fx = await createFixture({ dealerOn: false });
    const pos = await openPosition(fx, { openPrice: "90.00" });
    await refreshPrice(fx);
    const { status, json } = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(status).toBe(200);
    expect(json.queued).toBeUndefined();
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe("CLOSED");
  });
});
