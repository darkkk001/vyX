// Owner decision (2026-09-26): every ask-side execution uses the account's marked-up ask -- a SELL closes (trader close,
// bulk close, admin close, SL / TP, stop-out) and is valued (P/L, margin) at it; a BUY closes at the raw bid; the
// coverage account stays raw; a BUY LIMIT/STOP triggers on the account's ask; SL/TP modify checks a SELL against it.
// Real routes and lib functions on the scratch DB. Fixture: CRYPTO symbol (trades at weekends), digits 2 (pip 0.1),
// raw bid 100.00 / ask 100.10, the group's markup 1.5 pips = +0.15 -> the account's ask is 100.25.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);
const brokers: string[] = [];
const symbols: string[] = [];

type Fx = { brokerId: string; symbolId: string; symbolName: string; groupId: string; accountId: string; coverageAccountId: string; adminId: string };

async function fixture(opts: { engine?: boolean; target?: string } = {}): Promise<Fx> {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Ask ${s}`, subdomain: `askt-${s}`, dealingModeAt: null, dealingDeskAutoFillAt: new Date(), pricingEngineEnabled: opts.engine ?? false } });
  brokers.push(broker.id);
  const symbol = await prisma.symbol.create({ data: { name: `AK${s.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  symbols.push(symbol.name);
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", hedgedMarginPct: D(200) } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `std-${s}`, dealingMode: "AUTO", category: "B_BOOK", leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50) } });
  await prisma.groupSymbolConfig.create({ data: { groupId: group.id, symbolId: symbol.id, spreadMarkup: D("1.5"), ...(opts.target ? { targetTotalSpreadPips: D(opts.target) } : {}) } });
  const account = await prisma.account.create({ data: { brokerId: broker.id, groupId: group.id, accountNumber: `44${s.slice(0, 6)}`, email: `a-${s}@t.local`, passwordHash: "x", fullName: "Ask Client", accountMode: "LIVE", balance: D(10000), leverage: 1 } });
  const covGroup = await prisma.group.create({ data: { brokerId: broker.id, name: `cov-${s}`, category: "COVERAGE", groupType: "COVERAGE", modeRestriction: "LIVE_ONLY", leverage: 500 } });
  // a markup configured on the coverage group too: the coverage account must still be raw
  await prisma.groupSymbolConfig.create({ data: { groupId: covGroup.id, symbolId: symbol.id, spreadMarkup: D("3") } });
  const cov = await prisma.account.create({ data: { brokerId: broker.id, groupId: covGroup.id, accountNumber: `45${s.slice(0, 6)}`, email: `c-${s}@t.local`, passwordHash: "x", fullName: "Coverage", accountMode: "LIVE", balance: D(100000), leverage: 500 } });
  await prisma.broker.update({ where: { id: broker.id }, data: { coverageAccountId: cov.id } });
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `adm-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  return { brokerId: broker.id, symbolId: symbol.id, symbolName: symbol.name, groupId: group.id, accountId: account.id, coverageAccountId: cov.id, adminId: admin.id };
}

async function open(fx: Fx, side: "BUY" | "SELL", openPrice: string, opts: { accountId?: string; sl?: string; volume?: string } = {}) {
  const accountId = opts.accountId ?? fx.accountId;
  const order = await prisma.order.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side, type: "MARKET", volume: D(opts.volume ?? "1"), requestedPrice: D(openPrice), idempotencyKey: `o:${randomUUID()}`, status: "FILLED", filledPrice: D(openPrice), filledAt: new Date() } });
  return prisma.position.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: order.id, side, volume: D(opts.volume ?? "1"), openPrice: D(openPrice), slPrice: opts.sl ? D(opts.sl) : null } });
}

async function tick(fx: Fx, bid = "100.00", ask = "100.10") {
  await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D(bid), ask: D(ask), tickAt: new Date() } });
}

async function asTrader(fx: Fx) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
}
async function asAdmin(fx: Fx) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
}
const req = (url: string, method: string, body?: unknown) => new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const closedAt = async (id: string) => (await prisma.position.findUniqueOrThrow({ where: { id } })).closePrice?.toString() ?? null;

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
});
afterAll(async () => {
  const where = { brokerId: { in: brokers } };
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } });
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where });
  await prisma.dealerActivity?.deleteMany?.({ where }).catch(() => {});
  await prisma.postCloseEffect.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where });
  await prisma.position.updateMany({ where, data: { coveragePositionId: null, closePendingOrderId: null } });
  await prisma.order.updateMany({ where, data: { closesPositionId: null } });
  await prisma.position.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.groupSymbolConfig.deleteMany({ where: { group: where } });
  await prisma.group.deleteMany({ where });
  await prisma.brokerSymbol.deleteMany({ where });
  await prisma.adminUser.deleteMany({ where });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } });
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } });
}, 60_000);

describe("a SELL closes at the account's ask, a BUY at the raw bid", () => {
  it("trader close: SELL fills at 100.25 (raw ask 100.10 + 0.15); the realized P/L is off that price", async () => {
    const fx = await fixture();
    const pos = await open(fx, "SELL", "101.00");
    await tick(fx);
    await asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const res = await POST(req(`/api/trade/positions/${pos.id}/close`, "POST", { closePrice: "100.25", maxSlippagePips: "0" }), { params: Promise.resolve({ id: pos.id }) });
    expect(res.status).toBe(200);
    expect(await closedAt(pos.id)).toBe("100.25");
    const pnl = await prisma.transaction.findFirstOrThrow({ where: { accountId: fx.accountId, type: "TRADE_PNL" } });
    expect(pnl.amount.toNumber()).toBe(0.75); // (101.00 - 100.25) x 1 x 1
  });

  it("an older client's raw-ask reference is not refused as slippage (the markup is not market movement); the fill is still the account's ask", async () => {
    const fx = await fixture();
    const pos = await open(fx, "SELL", "101.00");
    await tick(fx);
    await asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const res = await POST(req(`/api/trade/positions/${pos.id}/close`, "POST", { closePrice: "100.10", maxSlippagePips: "0" }), { params: Promise.resolve({ id: pos.id }) });
    expect(res.status).toBe(200);
    expect(await closedAt(pos.id)).toBe("100.25");
  });

  it("a reference off both prices is still refused", async () => {
    const fx = await fixture();
    const pos = await open(fx, "SELL", "101.00");
    await tick(fx);
    await asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const res = await POST(req(`/api/trade/positions/${pos.id}/close`, "POST", { closePrice: "99.50", maxSlippagePips: "1" }), { params: Promise.resolve({ id: pos.id }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("SLIPPAGE_EXCEEDED");
  });

  it("BUY close stays at the raw bid", async () => {
    const fx = await fixture();
    const pos = await open(fx, "BUY", "99.00");
    await tick(fx);
    await asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const res = await POST(req(`/api/trade/positions/${pos.id}/close`, "POST", { closePrice: "100.00", maxSlippagePips: "0" }), { params: Promise.resolve({ id: pos.id }) });
    expect(res.status).toBe(200);
    expect(await closedAt(pos.id)).toBe("100");
  });

  it("pricing engine on, target mode (3 pips over a 1-pip raw spread): SELL closes at max(ask, bid + 0.30) = 100.30", async () => {
    const fx = await fixture({ engine: true, target: "3" });
    const pos = await open(fx, "SELL", "101.00");
    await tick(fx);
    await asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const res = await POST(req(`/api/trade/positions/${pos.id}/close`, "POST", { closePrice: "100.30", maxSlippagePips: "0" }), { params: Promise.resolve({ id: pos.id }) });
    expect(res.status).toBe(200);
    expect(await closedAt(pos.id)).toBe("100.3");
  });

  it("bulk close: SELL at 100.25, BUY at 100.00, and LOSS/PROFIT classified on those prices", async () => {
    const fx = await fixture();
    const s = await open(fx, "SELL", "100.20"); // at 100.25: a LOSS (it would be a profit at the raw 100.10)
    const b = await open(fx, "BUY", "99.00");
    await tick(fx);
    const { closeBulkForAccount } = await import("@/lib/bulk-close");
    const loss = await closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "LOSS" });
    expect(loss.map((r) => r.positionId)).toEqual([s.id]);
    expect(await closedAt(s.id)).toBe("100.25");
    await closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "ALL" });
    expect(await closedAt(b.id)).toBe("100");
  });

  it("admin close: a client SELL at 100.25; the coverage account's SELL raw at 100.10 despite a markup on its group", async () => {
    const fx = await fixture();
    const client = await open(fx, "SELL", "101.00");
    const leg = await open(fx, "SELL", "101.00", { accountId: fx.coverageAccountId });
    await tick(fx);
    await asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/[id]/close/route");
    for (const p of [client, leg]) {
      const res = await POST(req(`/api/manage/positions/${p.id}/close`, "POST", { reason: "test" }), { params: Promise.resolve({ id: p.id }) });
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    }
    expect(await closedAt(client.id)).toBe("100.25");
    expect(await closedAt(leg.id)).toBe("100.1");
  });
});

describe("SELL SL / TP and stop-out trigger on the account's ask", () => {
  it("SL 100.20 sits above the raw ask (100.10) but below the account's ask (100.25): it triggers, and closes at 100.25", async () => {
    const fx = await fixture();
    const pos = await open(fx, "SELL", "99.00", { sl: "100.20" });
    await tick(fx);
    const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
    const r = await evaluateAccountRisk(fx.accountId);
    expect(r.slTpClosed).toEqual([pos.id]);
    expect(await closedAt(pos.id)).toBe("100.25");
  });

  it("stop-out: at the raw ask the level is 50.15 % (> 50), at the account's ask 49.93 % (<= 50): stopped out at 100.25", async () => {
    const fx = await fixture();
    await prisma.account.update({ where: { id: fx.accountId }, data: { balance: D("50.30") } });
    const pos = await open(fx, "SELL", "100.00");
    await tick(fx);
    const { accountMarginLevel, evaluateAccountRisk } = await import("@/lib/risk-monitor");
    expect((await accountMarginLevel(fx.accountId))!.toFixed(2)).toBe("49.93"); // (50.30 - 0.25) / 100.25
    const r = await evaluateAccountRisk(fx.accountId);
    expect(r.stopOutClosed).toEqual([pos.id]);
    expect(await closedAt(pos.id)).toBe("100.25");
  });

  it("the pre-trade margin state values an open SELL at the account's ask", async () => {
    const fx = await fixture();
    await open(fx, "SELL", "100.00");
    await tick(fx);
    const { loadAccountMarginState } = await import("@/lib/margin");
    const st = (await loadAccountMarginState(prisma, fx.accountId, 1))!;
    expect(st.equity.toString()).toBe("9999.75"); // 10000 + (100.00 - 100.25)
    expect(st.usedMargin.toString()).toBe("100.25");
  });

  it("SL/TP modify: a SELL SL of 100.20 is refused (it must be above the account's ask 100.25); 100.30 is accepted", async () => {
    const fx = await fixture();
    const pos = await open(fx, "SELL", "99.00");
    await tick(fx);
    await asTrader(fx);
    const { PATCH } = await import("@/app/api/trade/positions/[id]/route");
    const bad = await PATCH(req(`/api/trade/positions/${pos.id}`, "PATCH", { slPrice: "100.20" }), { params: Promise.resolve({ id: pos.id }) });
    expect(bad.status).toBe(400);
    const ok = await PATCH(req(`/api/trade/positions/${pos.id}`, "PATCH", { slPrice: "100.30" }), { params: Promise.resolve({ id: pos.id }) });
    expect(ok.status).toBe(200);
  });
});

describe("a BUY LIMIT triggers on the account's ask (the price it fills at)", () => {
  it("entry 100.20: the raw ask 100.10 reaches it but the account's ask 100.25 does not -- not triggered", async () => {
    const fx = await fixture();
    const order = await prisma.order.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "LIMIT", volume: D("0.1"), requestedPrice: D("100.20"), idempotencyKey: `l:${randomUUID()}`, status: "PENDING" } });
    await tick(fx);
    const { evaluatePendingTriggers } = await import("@/lib/pending-trigger");
    await evaluatePendingTriggers([fx.symbolName]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING");
    // the account's ask falls to the entry: 100.05 + 0.15 = 100.20 -> triggered, filled at the account's ask 100.20
    await tick(fx, "99.95", "100.05");
    await evaluatePendingTriggers([fx.symbolName]);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("FILLED");
    expect(after.filledPrice?.toString()).toBe("100.2");
  });
});

describe("the backoffice rows carry the account's price and rule", () => {
  it("GET /api/manage/positions: a SELL row's currentPrice is 100.25 with askMarkup 0.15; the coverage row is raw", async () => {
    const fx = await fixture();
    const s = await open(fx, "SELL", "101.00");
    const c = await open(fx, "SELL", "101.00", { accountId: fx.coverageAccountId });
    await tick(fx);
    await asAdmin(fx);
    const { GET } = await import("@/app/api/manage/positions/route");
    const res = await GET(req("/api/manage/positions", "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = (body.positions ?? body.rows ?? body) as { id: string; currentPrice: string; floatingPnl: string; askMarkup: string; spreadRule: string }[];
    const row = rows.find((r) => r.id === s.id)!;
    expect([row.currentPrice, row.floatingPnl, row.askMarkup, row.spreadRule]).toEqual(["100.25", "0.75", "0.15", "markup"]);
    const cov = rows.find((r) => r.id === c.id)!;
    expect([cov.currentPrice, cov.askMarkup]).toEqual(["100.10", "0"]);
  });
});
