import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { expireOffer, expireStaleOffers, isOfferExpired, OFFER_EXPIRED, offerExpiresAt } from "@/lib/order-expiry";

// Dealer queue expiry (owner 2026-10-29, lib/order-expiry.ts). Real fixtures on the local scratch DB, own cleanup (same
// shape as app/api/manage/dealing-queue/[id]/route.test.ts). Ages are set with raw SQL: Prisma stamps updatedAt itself.
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
    console.warn("order-expiry.test.ts: DB unreachable, skipping");
  }
});

beforeEach(async () => {
  const { publishTradingEvent } = await import("@/lib/nats");
  vi.mocked(publishTradingEvent).mockClear();
});

type Fx = { brokerId: string; adminId: string; accountId: string; symbolId: string; symbolName: string };
const createdBrokerIds: string[] = [];

async function fixture(broker?: { requoteExpirySeconds?: number; offerExpirySeconds?: number }): Promise<Fx> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Expiry Test ${suffix}`, subdomain: `oxtest-${suffix}`, ...broker } });
  createdBrokerIds.push(b.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `ox-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.create({ data: { name: `OX${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", digits: 2 } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10") } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `TG-${suffix}`, dealingMode: "AUTO" } });
  const account = await prisma.account.create({
    data: { groupId: g.id, brokerId: b.id, accountNumber: `6${suffix.slice(0, 7)}`, email: `ox-${suffix}@test.local`, passwordHash: "x", fullName: "Expiry Test Client", accountMode: "LIVE", balance: D(1_000_000) },
  });
  return { brokerId: b.id, adminId: admin.id, accountId: account.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function order(fx: Fx, o: { status: "PENDING" | "REQUOTED"; type?: "MARKET" | "LIMIT" | "STOP"; closesPositionId?: string }) {
  return prisma.order.create({
    data: {
      brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: o.type ?? "MARKET", volume: D(1),
      requestedPrice: D("100.10"), requotedPrice: o.status === "REQUOTED" ? D("100.20") : null, executedAt: o.status === "REQUOTED" ? new Date() : null,
      idempotencyKey: `ox:${randomUUID()}`, status: o.status, closesPositionId: o.closesPositionId ?? null,
    },
  });
}

/** Ages an order: executedAt (the requote) and updatedAt (joined the queue) `seconds` ago; createdAt optionally older. */
async function age(orderId: string, seconds: number, createdSecondsAgo?: number) {
  const at = new Date(Date.now() - seconds * 1000);
  const created = new Date(Date.now() - (createdSecondsAgo ?? seconds) * 1000);
  await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = ${at}, "executedAt" = CASE WHEN "status" = 'REQUOTED' THEN ${at} ELSE "executedAt" END, "createdAt" = ${created} WHERE "id" = ${orderId}`;
}

async function openPosition(fx: Fx) {
  const o = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D("90"), idempotencyKey: `ox-open:${randomUUID()}`, status: "FILLED", filledPrice: D("90"), filledAt: new Date() },
  });
  return prisma.position.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D("90") } });
}

const status = async (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true, rejectionReason: true } });

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.position.updateMany({ where, data: { closePendingOrderId: null } });
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
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "OX" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "OX" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("offerExpiresAt (pure)", () => {
  const broker = { requoteExpirySeconds: 60, offerExpirySeconds: 300 };
  const t = new Date("2026-11-02T12:00:00Z");
  it("REQUOTED: 60 s after the requote (executedAt)", () => {
    expect(offerExpiresAt({ status: "REQUOTED", type: "MARKET", executedAt: t, updatedAt: new Date(0) }, broker)?.toISOString()).toBe("2026-11-02T12:01:00.000Z");
  });
  it("PENDING MARKET: 300 s after it joined the queue (updatedAt)", () => {
    expect(offerExpiresAt({ status: "PENDING", type: "MARKET", executedAt: null, updatedAt: t }, broker)?.toISOString()).toBe("2026-11-02T12:05:00.000Z");
  });
  it("resting LIMIT / STOP and finished orders: never", () => {
    for (const type of ["LIMIT", "STOP"]) expect(offerExpiresAt({ status: "PENDING", type, executedAt: null, updatedAt: new Date(0) }, broker)).toBeNull();
    for (const s of ["FILLED", "CANCELLED", "REJECTED"]) expect(offerExpiresAt({ status: s, type: "MARKET", executedAt: t, updatedAt: t }, broker)).toBeNull();
  });
  it("expired exactly at the deadline", () => {
    const o = { status: "REQUOTED", type: "MARKET", executedAt: t, updatedAt: t };
    expect(isOfferExpired(o, broker, new Date(t.getTime() + 59_999))).toBe(false);
    expect(isOfferExpired(o, broker, new Date(t.getTime() + 60_000))).toBe(true);
  });
});

describe("expireStaleOffers (sweep)", () => {
  it("expires a requote past 60 s: CANCELLED + OFFER_EXPIRED, one audit row, one OrderCancelled event", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const o = await order(fx, { status: "REQUOTED" });
    await age(o.id, 61);
    const r = await expireStaleOffers(prisma, new Date(), fx.brokerId);
    expect(r).toMatchObject({ expired: 1, errors: 0 });
    expect(await status(o.id)).toEqual({ status: "CANCELLED", rejectionReason: OFFER_EXPIRED });
    const audits = await prisma.auditLog.findMany({ where: { entityId: o.id, action: "DEALING_ORDER_EXPIRED" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].oldValue).toMatchObject({ status: "REQUOTED", requotedPrice: "100.2" });
    const { publishTradingEvent } = await import("@/lib/nats");
    expect(vi.mocked(publishTradingEvent)).toHaveBeenCalledWith("OrderCancelled", expect.objectContaining({ order_id: o.id, reason: OFFER_EXPIRED, broker_id: fx.brokerId }));
  });

  it("leaves a requote inside its window alone", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const o = await order(fx, { status: "REQUOTED" });
    await age(o.id, 30);
    expect((await expireStaleOffers(prisma, new Date(), fx.brokerId)).expired).toBe(0);
    expect((await status(o.id)).status).toBe("REQUOTED");
  });

  it("expires a MARKET order waiting for the dealer past 300 s, not before", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const old = await order(fx, { status: "PENDING" });
    const fresh = await order(fx, { status: "PENDING" });
    await age(old.id, 301);
    await age(fresh.id, 120);
    expect((await expireStaleOffers(prisma, new Date(), fx.brokerId)).expired).toBe(1);
    expect((await status(old.id)).status).toBe("CANCELLED");
    expect((await status(fresh.id)).status).toBe("PENDING");
  });

  it("never touches a resting LIMIT / STOP order, however old", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const limit = await order(fx, { status: "PENDING", type: "LIMIT" });
    const stop = await order(fx, { status: "PENDING", type: "STOP" });
    await age(limit.id, 86_400 * 5);
    await age(stop.id, 86_400 * 5);
    expect((await expireStaleOffers(prisma, new Date(), fx.brokerId)).expired).toBe(0);
    expect((await status(limit.id)).status).toBe("PENDING");
    expect((await status(stop.id)).status).toBe("PENDING");
  });

  it("a triggered pending order that just joined the queue is not expired by its old createdAt", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const o = await order(fx, { status: "PENDING" });
    await age(o.id, 10, 86_400 * 3); // created 3 days ago as a LIMIT, turned MARKET (queued) 10 s ago
    expect((await expireStaleOffers(prisma, new Date(), fx.brokerId)).expired).toBe(0);
    expect((await status(o.id)).status).toBe("PENDING");
  });

  it("per-broker settings override the defaults", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ requoteExpirySeconds: 10, offerExpirySeconds: 20 });
    const rq = await order(fx, { status: "REQUOTED" });
    const pd = await order(fx, { status: "PENDING" });
    await age(rq.id, 15);
    await age(pd.id, 25);
    expect((await expireStaleOffers(prisma, new Date(), fx.brokerId)).expired).toBe(2);
  });

  it("a queued CLOSE releases its position's lock; a lock held by another order stays", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const pos = await openPosition(fx);
    const close = await order(fx, { status: "REQUOTED", closesPositionId: pos.id });
    await prisma.position.update({ where: { id: pos.id }, data: { closePendingOrderId: close.id } });
    await age(close.id, 61);
    await expireStaleOffers(prisma, new Date(), fx.brokerId);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).closePendingOrderId).toBeNull();

    // a stale close whose position is now locked by a newer close: the newer lock is not touched
    const pos2 = await openPosition(fx);
    const stale = await order(fx, { status: "PENDING", closesPositionId: pos2.id });
    const newer = await order(fx, { status: "PENDING", closesPositionId: pos2.id });
    await prisma.position.update({ where: { id: pos2.id }, data: { closePendingOrderId: newer.id } });
    await age(stale.id, 301);
    await expireStaleOffers(prisma, new Date(), fx.brokerId);
    expect((await status(stale.id)).status).toBe("CANCELLED");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos2.id } })).closePendingOrderId).toBe(newer.id);
  });

  it("compare-and-set: an order someone answered first is skipped (no audit, no event)", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const o = await order(fx, { status: "REQUOTED" });
    await age(o.id, 61);
    const read = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    await prisma.order.update({ where: { id: o.id }, data: { status: "FILLED", filledPrice: D("100.2"), filledAt: new Date() } }); // the client accepted first
    const did = await expireOffer(prisma, { ...read, symbolName: fx.symbolName, accountNumber: "x", closesPositionId: null });
    expect(did).toBe(false);
    expect((await status(o.id)).status).toBe("FILLED");
    expect(await prisma.auditLog.count({ where: { entityId: o.id, action: "DEALING_ORDER_EXPIRED" } })).toBe(0);
    const { publishTradingEvent } = await import("@/lib/nats");
    expect(vi.mocked(publishTradingEvent)).not.toHaveBeenCalled();
  });
});

describe("on-read expiry at the accept paths", () => {
  it("client accepting an expired requote: 409, order CANCELLED + OFFER_EXPIRED, no position", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const o = await order(fx, { status: "REQUOTED" });
    await age(o.id, 61);
    const { getAccountSession } = await import("@/lib/account-auth");
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
    const { POST } = await import("@/app/api/trade/orders/[id]/requote-response/route");
    const res = await POST(
      new NextRequest(`https://test.local/api/trade/orders/${o.id}/requote-response`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: true }) }),
      { params: Promise.resolve({ id: o.id }) }
    );
    expect(res.status).toBe(409);
    expect(await status(o.id)).toEqual({ status: "CANCELLED", rejectionReason: OFFER_EXPIRED });
    expect(await prisma.position.count({ where: { originOrderId: o.id } })).toBe(0);
  });

  it("dealer ACCEPT of an expired queued order: 409 OFFER_EXPIRED, no position", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const o = await order(fx, { status: "PENDING" });
    await age(o.id, 301);
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
    const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
    const res = await PATCH(
      new NextRequest(`https://test.local/api/manage/dealing-queue/${o.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ACCEPT" }) }),
      { params: Promise.resolve({ id: o.id }) }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(OFFER_EXPIRED);
    expect((await status(o.id)).status).toBe("CANCELLED");
    expect(await prisma.position.count({ where: { originOrderId: o.id } })).toBe(0);
  });

  it("a fresh queued order is still accepted normally", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const o = await order(fx, { status: "PENDING" });
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
    const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
    const res = await PATCH(
      new NextRequest(`https://test.local/api/manage/dealing-queue/${o.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ACCEPT" }) }),
      { params: Promise.resolve({ id: o.id }) }
    );
    expect(res.status).toBe(200);
    expect((await status(o.id)).status).toBe("FILLED");
  });

  it("the desk's queue: stale rows leave it, every row carries expiresAt", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const stale = await order(fx, { status: "REQUOTED" });
    const live = await order(fx, { status: "REQUOTED" });
    const queued = await order(fx, { status: "PENDING" });
    await age(stale.id, 61);
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
    const { GET } = await import("@/app/api/manage/dealing-queue/route");
    const json = await (await GET()).json();
    expect(json.requotedRows.map((r: { id: string }) => r.id)).toEqual([live.id]);
    expect(json.rows.map((r: { id: string }) => r.id)).toEqual([queued.id]);
    for (const r of [...json.rows, ...json.requotedRows]) expect(Number.isNaN(Date.parse(r.expiresAt))).toBe(false);
    expect((await status(stale.id)).status).toBe("CANCELLED");
  });
});
