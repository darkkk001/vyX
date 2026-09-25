import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Audit 2026-09-24 Batch 4 (money). Real fixtures on the local scratch DB, own cleanup.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

import { pendingTriggered, evaluatePendingTriggers, triggerPendingOrder } from "@/lib/pending-trigger";
import { rollDayStart, fallbackDayStart, tradingDayStart } from "@/lib/trading-day";
import { computePendingCommission } from "@/lib/commission";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("money-batch4.test.ts: DB unreachable, skipping");
  }
});

const brokers: string[] = [];
const symbols: string[] = [];
const clients: string[] = [];
type Fx = { brokerId: string; groupId: string; symbolId: string; symbolName: string };

async function broker(opts?: { groupType?: "DEALING" | "LP"; forceDealingMode?: boolean }): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Money B4 ${sfx}`, subdomain: `mb4-${sfx}` } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `MQ${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D("99.90"), ask: D("100.10") } });
  const g = await prisma.group.create({
    data: { brokerId: b.id, name: `MB4-${sfx}`, leverage: 100, dealingMode: "AUTO", isClientSelectable: true, groupType: opts?.groupType ?? "DEALING", forceDealingMode: opts?.forceDealingMode ?? false },
  });
  return { brokerId: b.id, groupId: g.id, symbolId: sym.id, symbolName: sym.name };
}
const admin = (fx: Fx, role: "BROKER_ADMIN" | "MANAGER", perms: string[] = []) =>
  prisma.adminUser.create({ data: { brokerId: fx.brokerId, email: `mb4-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role, extraPermissions: perms } });
async function account(fx: Fx, balance = 100000, mode: "LIVE" | "DEMO" = "LIVE") {
  const n = `6${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "7")}`;
  return prisma.account.create({ data: { groupId: fx.groupId, brokerId: fx.brokerId, accountNumber: n, email: `c-${n}@test.local`, passwordHash: "x", fullName: "B4 Client", accountMode: mode, balance: D(balance) } });
}
async function pending(fx: Fx, accountId: string, side: "BUY" | "SELL", type: "LIMIT" | "STOP", entry: string, lots = 1) {
  return prisma.order.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side, type, volume: D(lots), requestedPrice: D(entry), idempotencyKey: `mb4:${randomUUID()}`, status: "PENDING" } });
}
async function position(fx: Fx, accountId: string, lots: number, extra?: { status?: "OPEN" | "CLOSED"; closedAt?: Date; realizedPnl?: number }) {
  const o = await prisma.order.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(lots), requestedPrice: D(100), idempotencyKey: `mb4:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
  return prisma.position.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: o.id, side: "BUY", volume: D(lots), openPrice: D(100), status: extra?.status ?? "OPEN", closedAt: extra?.closedAt ?? null, closePrice: extra?.status === "CLOSED" ? D(100) : null, realizedPnl: extra?.realizedPnl != null ? D(extra.realizedPnl) : null },
  });
}
async function as(fx: Fx, a: { id: string; role: string }) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: fx.brokerId } as never);
}
async function call(handler: unknown, url: string, method: string, body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  if (brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } });
    await prisma.liveAccountRequest.deleteMany({ where }).catch(() => {});
    await prisma.balanceAdjustmentRequest.deleteMany({ where });
    await prisma.paymentMethod.deleteMany({ where }).catch(() => {});
    await prisma.ibRelationship.deleteMany({ where });
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.updateMany({ where, data: { coveragePositionId: null } });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.client.deleteMany({ where: { id: { in: clients } } }).catch(() => {});
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.group.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

describe("pending LIMIT / STOP trigger, server-side", () => {
  it("trigger conditions: a BUY trades at the ask, a SELL at the bid", () => {
    const bid = D("99.90"), ask = D("100.10");
    expect(pendingTriggered({ side: "BUY", type: "LIMIT" }, D("100.10"), bid, ask)).toBe(true);
    expect(pendingTriggered({ side: "BUY", type: "LIMIT" }, D("100.00"), bid, ask)).toBe(false);
    expect(pendingTriggered({ side: "BUY", type: "STOP" }, D("100.05"), bid, ask)).toBe(true);
    expect(pendingTriggered({ side: "SELL", type: "LIMIT" }, D("99.90"), bid, ask)).toBe(true);
    expect(pendingTriggered({ side: "SELL", type: "STOP" }, D("99.80"), bid, ask)).toBe(false);
  });

  it("the sweep fills a reached order at the server price, leaves an unreached one, and rejects an unaffordable one ONCE", async () => {
    if (!dbReachable) return;
    const fx = await broker({ groupType: "LP" });
    const rich = await account(fx);
    const poor = await account(fx, 10);
    const reached = await pending(fx, rich.id, "BUY", "LIMIT", "100.20");
    const notYet = await pending(fx, rich.id, "BUY", "LIMIT", "95.00");
    const tooBig = await pending(fx, poor.id, "BUY", "LIMIT", "100.20", 5);

    const r1 = await evaluatePendingTriggers([fx.symbolName]);
    expect(r1.filled).toBe(1);
    expect(r1.rejected).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: reached.id } })).status).toBe("FILLED");
    const pos = await prisma.position.findFirstOrThrow({ where: { originOrderId: reached.id } });
    expect(pos.openPrice.toString()).toBe("100.1"); // the live ask, not the entry
    expect((await prisma.order.findUniqueOrThrow({ where: { id: notYet.id } })).status).toBe("PENDING");
    const rej = await prisma.order.findUniqueOrThrow({ where: { id: tooBig.id } });
    expect(rej.status).toBe("REJECTED");
    expect(rej.rejectionReason).toMatch(/INSUFFICIENT/);

    // the next pass does nothing more: no re-trigger loop
    const r2 = await evaluatePendingTriggers([fx.symbolName]);
    expect(r2.filled + r2.rejected).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: tooBig.id, action: "PENDING_ORDER_REJECTED_AT_TRIGGER" } })).toBe(1);
  });

  it("a server trigger and an older terminal's fill POST at the same moment open ONE position", async () => {
    if (!dbReachable) return;
    const fx = await broker({ groupType: "LP" });
    const acc = await account(fx);
    const o = await pending(fx, acc.id, "BUY", "STOP", "100.00");
    const results = await Promise.all([triggerPendingOrder(o.id, "100.10", "server"), triggerPendingOrder(o.id, "100.10", "client")]);
    expect(results.filter((r) => r.kind === "filled")).toHaveLength(1);
    expect(await prisma.position.count({ where: { originOrderId: o.id } })).toBe(1);
  });

  it("an older terminal re-POSTing a rejected order gets 409 (the loop ends)", async () => {
    if (!dbReachable) return;
    const fx = await broker({ groupType: "LP" });
    const acc = await account(fx, 10);
    const o = await pending(fx, acc.id, "BUY", "LIMIT", "100.20", 5);
    const { getAccountSession } = await import("@/lib/account-auth");
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: fx.brokerId } as never);
    const { POST } = await import("@/app/api/trade/orders/[id]/fill/route");
    const first = await call(POST, `/api/trade/orders/${o.id}/fill`, "POST", { price: "100.10" }, { id: o.id });
    expect(first.status).toBe(400);
    expect(first.json.rejected).toBe(true);
    const again = await call(POST, `/api/trade/orders/${o.id}/fill`, "POST", { price: "100.10" }, { id: o.id });
    expect(again.status).toBe(409);
  });
});

describe("trading day (the charts' D1 boundary)", () => {
  it("rolls a known day start forward whole days; the fallback is the latest 22:00 UTC", () => {
    const d1 = new Date("2026-09-24T21:00:00Z");
    expect(rollDayStart(d1, new Date("2026-09-25T10:00:00Z")).toISOString()).toBe("2026-09-24T21:00:00.000Z");
    expect(rollDayStart(d1, new Date("2026-09-25T21:30:00Z")).toISOString()).toBe("2026-09-25T21:00:00.000Z");
    expect(fallbackDayStart(new Date("2026-09-25T10:00:00Z")).toISOString()).toBe("2026-09-24T22:00:00.000Z");
    expect(fallbackDayStart(new Date("2026-09-25T22:30:00Z")).toISOString()).toBe("2026-09-25T22:00:00.000Z");
  });

  it("reads the latest D1 candle (summer: 21:00 UTC)", async () => {
    if (!dbReachable) return;
    const now = new Date();
    const start = new Date(now); start.setUTCHours(21, 0, 0, 0); if (start > now) start.setUTCDate(start.getUTCDate() - 1);
    const existing = await prisma.candle.findFirst({ where: { symbol: "XAUUSD", timeframe: "D1", bucketStart: start } });
    const made = existing ? null : await prisma.candle.create({ data: { symbol: "XAUUSD", timeframe: "D1", bucketStart: start, open: D(1), high: D(1), low: D(1), close: D(1) } as never });
    try {
      const td = await tradingDayStart(now);
      expect(td.source).toBe("d1-candle");
      expect(td.start.getUTCHours()).toBe(21);
    } finally {
      if (made) await prisma.candle.deleteMany({ where: { symbol: "XAUUSD", timeframe: "D1", bucketStart: start } }).catch(() => {});
    }
  });
});

describe("permissions (owner decisions 16 / 20) and reject = approve authority", () => {
  it("CLIENT_TRADING: a MANAGER without it cannot close a client position; with it, can", async () => {
    if (!dbReachable) return;
    const fx = await broker({ groupType: "LP" });
    const acc = await account(fx);
    const pos = await position(fx, acc.id, 1);
    const plain = await admin(fx, "MANAGER");
    const trader = await admin(fx, "MANAGER", ["CLIENT_TRADING"]);
    const { POST } = await import("@/app/api/manage/positions/[id]/close/route");
    await as(fx, plain);
    const refused = await call(POST, `/api/manage/positions/${pos.id}/close`, "POST", {}, { id: pos.id });
    expect(refused.status).toBe(403);
    expect(refused.json.permission).toBe("CLIENT_TRADING");
    await as(fx, trader);
    const ok = await call(POST, `/api/manage/positions/${pos.id}/close`, "POST", {}, { id: pos.id });
    expect(ok.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { entityId: pos.id, action: "MANUAL_POSITION_CLOSE" } })).toBeGreaterThanOrEqual(1);
  });

  it("PRICING: a MANAGER cannot change a symbol's spread markup, but can still change a non-pricing field", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const mgr = await admin(fx, "MANAGER");
    const bs = await prisma.brokerSymbol.findFirstOrThrow({ where: { brokerId: fx.brokerId } });
    const base = { symbolId: fx.symbolId, spreadMarkup: "0", minLot: "0.01", maxLot: "100", lotStep: "0.01", commissionPerLot: "0", swapLong: "0", swapShort: "0", enabled: true, tradingMode: "BOTH", hedgedMarginPct: bs.hedgedMarginPct.toString() };
    const { PATCH } = await import("@/app/api/manage/symbols/route");
    await as(fx, mgr);
    const refused = await call(PATCH, "/api/manage/symbols", "PATCH", { ...base, spreadMarkup: "1.5" });
    expect(refused.status).toBe(403);
    expect(refused.json.permission).toBe("PRICING");
    const ok = await call(PATCH, "/api/manage/symbols", "PATCH", { ...base, maxLot: "50" });
    expect(ok.status).toBe(200);
  });

  it("DEALING: a MANAGER without it cannot act on the dealer queue", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const acc = await account(fx);
    const o = await prisma.order.create({ data: { brokerId: fx.brokerId, accountId: acc.id, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D("100.10"), idempotencyKey: `mb4:${randomUUID()}`, status: "PENDING" } });
    const mgr = await admin(fx, "MANAGER");
    await as(fx, mgr);
    const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
    const r = await call(PATCH, `/api/manage/dealing-queue/${o.id}`, "PATCH", { action: "ACCEPT" }, { id: o.id });
    expect(r.status).toBe(403);
    expect(r.json.permission).toBe("DEALING");
  });

  it("a MANAGER without finance rights cannot reject an approval request", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const acc = await account(fx);
    const fin = await admin(fx, "MANAGER", ["ACCOUNT_FINANCE"]);
    const plain = await admin(fx, "MANAGER");
    const req = await prisma.balanceAdjustmentRequest.create({ data: { brokerId: fx.brokerId, accountId: acc.id, amount: D(10), note: "t", requestedByAdminId: fin.id } });
    await as(fx, plain);
    const { POST } = await import("@/app/api/manage/balance-adjustment-requests/[id]/reject/route");
    const r = await call(POST, `/api/manage/balance-adjustment-requests/${req.id}/reject`, "POST", {}, { id: req.id });
    expect(r.status).toBe(403);
    expect((await prisma.balanceAdjustmentRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("PENDING");
  });
});

describe("partner commission fixed at close (decision 8) and no demo partner links", () => {
  it("a rate edit locks trades already closed at the old rate", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const ba = await admin(fx, "BROKER_ADMIN");
    const ib = await account(fx, 0);
    const client = await account(fx);
    await position(fx, client.id, 2, { status: "CLOSED", closedAt: new Date(Date.now() - 60_000), realizedPnl: 0 });
    const rel = await prisma.ibRelationship.create({ data: { brokerId: fx.brokerId, ibAccountId: ib.id, clientAccountId: client.id, commissionType: "PER_LOT", commissionRate: D(5) } });
    expect((await computePendingCommission(prisma, rel)).toString()).toBe("10");
    await as(fx, ba);
    const { PATCH } = await import("@/app/api/manage/ib-relationships/[id]/route");
    expect((await call(PATCH, `/api/manage/ib-relationships/${rel.id}`, "PATCH", { commissionRate: "20" }, { id: rel.id })).status).toBe(200);
    // the 2 lots closed before the edit stay at 5/lot; a trade closed after uses 20/lot
    await new Promise((r) => setTimeout(r, 20));
    await position(fx, client.id, 1, { status: "CLOSED", closedAt: new Date(), realizedPnl: 0 });
    const after = await prisma.ibRelationship.findUniqueOrThrow({ where: { id: rel.id } });
    expect((await computePendingCommission(prisma, after)).toString()).toBe("30");
  });

  it("a partner link on a demo account is refused", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const ba = await admin(fx, "BROKER_ADMIN");
    const ib = await account(fx, 0);
    const demo = await account(fx, 1000, "DEMO");
    await as(fx, ba);
    const { POST } = await import("@/app/api/manage/ib-relationships/route");
    const r = await call(POST, "/api/manage/ib-relationships", "POST", { ibAccountId: ib.id, clientAccountId: demo.id, commissionType: "PER_LOT", commissionRate: "5" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/LIVE/);
  });
});

describe("audit / guards", () => {
  it("payment-method changes write an audit row with old and new values", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const ba = await admin(fx, "BROKER_ADMIN");
    await as(fx, ba);
    const { PATCH } = await import("@/app/api/manage/payment-methods/route");
    const body = { type: "USDT_TRC20", enabled: true, minAmount: "10", maxAmount: "", feePercent: "0", feeFixed: "0", walletAddress: "TAAA" };
    expect((await call(PATCH, "/api/manage/payment-methods", "PATCH", body)).status).toBe(200);
    expect((await call(PATCH, "/api/manage/payment-methods", "PATCH", { ...body, walletAddress: "TBBB" })).status).toBe(200);
    const upd = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.brokerId, action: "PAYMENT_METHOD_UPDATED" } });
    expect((upd.oldValue as Record<string, unknown>).walletAddress).toBe("TAAA");
    expect((upd.newValue as Record<string, unknown>).walletAddress).toBe("TBBB");
  });

  it("SL/TP are checked against the server price, not the one the client sends", async () => {
    if (!dbReachable) return;
    const fx = await broker({ groupType: "LP" });
    const acc = await account(fx);
    const pos = await position(fx, acc.id, 1);
    const { getAccountSession } = await import("@/lib/account-auth");
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: fx.brokerId } as never);
    const { PATCH } = await import("@/app/api/trade/positions/[id]/route");
    // a BUY's SL must be below the bid (99.90); the client lies that the price is 200
    const r = await call(PATCH, `/api/trade/positions/${pos.id}`, "PATCH", { currentPrice: "200", slPrice: "150" }, { id: pos.id });
    expect(r.status).toBe(400);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).slPrice).toBeNull();
  });

  it("close shown positions closes exactly the listed ids, across accounts", async () => {
    if (!dbReachable) return;
    const fx = await broker({ groupType: "LP" });
    const ba = await admin(fx, "BROKER_ADMIN");
    const a = await account(fx);
    const b = await account(fx);
    const p1 = await position(fx, a.id, 1);
    const p2 = await position(fx, b.id, 1);
    const keep = await position(fx, b.id, 1);
    await as(fx, ba);
    const { POST } = await import("@/app/api/manage/positions/close-bulk/route");
    const r = await call(POST, "/api/manage/positions/close-bulk", "POST", { positionIds: [p1.id, p2.id] });
    expect(r.status).toBe(200);
    expect(r.json.successful).toBe(2);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: keep.id } })).status).toBe("OPEN");
  });

  it("GET /api/trade/me returns the stop-out level", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    await prisma.group.update({ where: { id: fx.groupId }, data: { stopOutLevel: D(30) } });
    const acc = await account(fx);
    const { getAccountSession } = await import("@/lib/account-auth");
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: fx.brokerId } as never);
    const { GET } = await import("@/app/api/trade/me/route");
    const j = await (await (GET as unknown as () => Promise<Response>)()).json();
    expect(Number(j.stopOutLevel)).toBe(30);
  });
});

describe("live account applications (line 10)", () => {
  it("two admins approving the same application at once create ONE account", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const a1 = await admin(fx, "BROKER_ADMIN");
    await prisma.group.update({ where: { id: fx.groupId }, data: { isDefault: true } });
    const client = await prisma.client.create({ data: { brokerId: fx.brokerId, email: `lar-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", fullName: "LAR Client" } });
    clients.push(client.id);
    const req = await prisma.liveAccountRequest.create({ data: { brokerId: fx.brokerId, clientId: client.id } });
    await as(fx, a1);
    const { PATCH } = await import("@/app/api/manage/live-account-requests/[id]/route");
    const results = await Promise.all([1, 2].map(() => call(PATCH, `/api/manage/live-account-requests/${req.id}`, "PATCH", { action: "APPROVE" }, { id: req.id })));
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.account.count({ where: { clientId: client.id } })).toBe(1);
  });
});

describe("auto-hedge covers forced-dealing groups too (decision 1)", () => {
  it("a fill in a forced-dealing (non-DEALING-type) group is hedged when auto-hedge is on", async () => {
    if (!dbReachable) return;
    const fx = await broker({ groupType: "LP", forceDealingMode: true });
    await prisma.group.update({ where: { id: fx.groupId }, data: { category: "B_BOOK" } });
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { autoHedgeAt: new Date(), dealingDeskAutoFillAt: new Date() } });
    const acc = await account(fx);
    const pos = await position(fx, acc.id, 1);
    const coverage = await import("@/lib/coverage");
    await coverage.onFillAutoHedge(prisma, { positionId: pos.id, brokerId: fx.brokerId });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).covered).toBe(true);
  });
});
