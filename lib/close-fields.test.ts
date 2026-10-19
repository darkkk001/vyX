import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Structured close fields (hotfix 2026-10-12, docs/POSITION-DEAL-MODEL.md section 0): every close path writes
// closeVolume / closePrice / closeSwap (+ closeByPositionId) on its TRADE_PNL row, and Position keeps cumulative
// realizedPnl / closedVolume / closedSwap. One test (or more) per path, against the scratch database. Each fixture owns
// a private CRYPTO symbol (continuous session, contract size 1, quote USD) so prices are set per test and nothing
// depends on the weekday or on other tests.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn().mockResolvedValue(undefined) };
});

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "closedVolume" FROM "Position" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/close-fields.test.ts: DB unreachable or close_fields migration missing, skipping");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
}, 30000);

type Fx = { brokerId: string; adminId: string; accountId: string; accountNumber: string; groupId: string; symbolId: string; symbolName: string };

async function fixture(opts?: { dealing?: boolean; balance?: number }): Promise<Fx> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Close Fields ${suffix}`, subdomain: `cf-${suffix}`, dealingModeAt: null, dealingDeskAutoFillAt: null } });
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `cf-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.create({ data: { name: `CF${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(1000), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({
    data: { brokerId: broker.id, name: `CFG-${suffix}`, leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50), category: opts?.dealing ? "DEALING" : "B_BOOK" },
  });
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: `6${suffix.slice(0, 7)}`, email: `cf-client-${suffix}@test.local`, passwordHash: "x", fullName: "Close Fields Client", accountMode: "LIVE", leverage: 1, balance: D(opts?.balance ?? 100000) },
  });
  return { brokerId: broker.id, adminId: admin.id, accountId: account.id, accountNumber: account.accountNumber, groupId: group.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function setPrice(fx: Fx, bid: string, ask: string) {
  await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D(bid), ask: D(ask), tickAt: new Date() } });
}

async function open(fx: Fx, o: { side: "BUY" | "SELL"; volume: string; openPrice: string; swap?: string; sl?: string; tp?: string; accountId?: string }) {
  const accountId = o.accountId ?? fx.accountId;
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: o.side, type: "MARKET", volume: D(o.volume), requestedPrice: D(o.openPrice), idempotencyKey: `cf:${randomUUID()}`, status: "FILLED", filledPrice: D(o.openPrice), filledAt: new Date() },
  });
  return prisma.position.create({
    data: {
      brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: order.id, side: o.side, volume: D(o.volume), openPrice: D(o.openPrice),
      ...(o.swap ? { swap: D(o.swap) } : {}), slPrice: o.sl ? D(o.sl) : null, tpPrice: o.tp ? D(o.tp) : null,
    },
  });
}

const pnlRows = (positionId: string) => prisma.transaction.findMany({ where: { type: "TRADE_PNL", referenceType: "Position", referenceId: positionId }, orderBy: { createdAt: "asc" } });
const pos = (id: string) => prisma.position.findUniqueOrThrow({ where: { id } });
const sumSwap = (rows: { closeSwap: Prisma.Decimal | null }[]) => rows.reduce((s, r) => s.add(r.closeSwap ?? 0), D(0));

async function clientClose(fx: Fx, positionId: string, body: Record<string, unknown>) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
  const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
  const res = await POST(new NextRequest(`https://test.local/api/trade/positions/${positionId}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: positionId }) });
  return { status: res.status, json: await res.json() };
}

// --- client close (WebTrader and terminal both use this route) ---------------------------------------------------------

describe("client close route", () => {
  it("full close writes the structured fields and the cumulative position fields", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00", swap: "-2.50" });
    const res = await clientClose(fx, p.id, { closePrice: "100.00", maxSlippagePips: "5" });
    expect(res.status).toBe(200);
    const [row] = await pnlRows(p.id);
    expect(row.closeVolume?.toString()).toBe("1");
    expect(row.closePrice?.toString()).toBe("100");
    expect(row.closeSwap?.toString()).toBe("-2.5"); // the only close takes the whole remainder
    expect(row.closeByPositionId).toBeNull();
    const after = await pos(p.id);
    expect(after.status).toBe("CLOSED");
    expect(after.realizedPnl?.toString()).toBe("10");
    expect(after.closedVolume?.toString()).toBe("1");
    expect(after.closedSwap?.toString()).toBe("-2.5");
    expect(after.swap.toString()).toBe("-2.5"); // Position.swap stays the total accrued
  });

  it("partial then full: realizedPnl and closedVolume accumulate, every row carries its own lots and price, swap splits pro rata", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00", swap: "3.00" });
    const first = await clientClose(fx, p.id, { volume: "0.40", closePrice: "100.00", maxSlippagePips: "5" });
    expect(first.status).toBe(200);
    const mid = await pos(p.id);
    expect(mid.status).toBe("OPEN");
    expect(mid.volume.toString()).toBe("0.6"); // volume is still the open remainder
    expect(mid.realizedPnl?.toString()).toBe("4"); // cumulative already on a partial
    expect(mid.closedVolume?.toString()).toBe("0.4");
    expect(mid.closedSwap?.toString()).toBe("1.2"); // 3.00 * 0.40 / 1.00

    await setPrice(fx, "101.00", "101.10");
    const second = await clientClose(fx, p.id, { closePrice: "101.00", maxSlippagePips: "5" });
    expect(second.status).toBe(200);
    const rows = await pnlRows(p.id);
    expect(rows.map((r) => [r.closeVolume?.toString(), r.closePrice?.toString(), r.closeSwap?.toString(), r.amount.toString()])).toEqual([
      ["0.4", "100", "1.2", "4"],
      ["0.6", "101", "1.8", "6.6"],
    ]);
    const done = await pos(p.id);
    expect(done.status).toBe("CLOSED");
    expect(done.realizedPnl?.toString()).toBe("10.6");
    expect(done.closedVolume?.toString()).toBe("1");
    expect(done.closePrice?.toString()).toBe("101"); // the last close price
    expect(done.volume.toString()).toBe("0.6"); // unchanged behaviour: the last piece
    expect(sumSwap(rows).toString()).toBe(done.swap.toString());
    expect(done.closedSwap?.toString()).toBe("3");
  });
});

describe("pro-rata swap", () => {
  it("each partial takes its share of what is left, the final close takes the remainder, shares sum to Position.swap", async () => {
    if (!dbReachable) return;
    const { closePositionInTx } = await import("@/lib/position-close");
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "100.00", swap: "1.01" });
    let volume = D("1.00");
    for (const lots of ["0.33", "0.33", "0.34"]) {
      const cur = await pos(p.id);
      expect(cur.volume.toString()).toBe(volume.toString());
      const out = await prisma.$transaction((tx) =>
        closePositionInTx(tx, { deal: { reason: "CLIENT" }, position: { id: p.id, accountId: fx.accountId, brokerId: fx.brokerId, side: "BUY", openPrice: cur.openPrice, volume: cur.volume, symbol: { contractSize: D(1) } }, closePrice: "100", closeVolume: D(lots) })
      );
      expect(out.closed).toBe(true);
      volume = volume.sub(lots);
    }
    const rows = await pnlRows(p.id);
    expect(rows.map((r) => r.closeSwap?.toString())).toEqual(["0.33", "0.33", "0.35"]); // 1.01*.33=0.3333; .68*.33/.67=0.3349; remainder
    expect(sumSwap(rows).toString()).toBe("1.01");
    const done = await pos(p.id);
    expect(done.closedSwap?.toString()).toBe("1.01");
    expect(done.swap.toString()).toBe("1.01");
  });

  it("moves no money for swap: the balance changes by the P/L only", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "100.00", swap: "-7.00" });
    const before = (await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } })).balance;
    await clientClose(fx, p.id, { closePrice: "100.00", maxSlippagePips: "5" });
    const after = (await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } })).balance;
    expect(after.sub(before).toString()).toBe("0"); // closes at the bid (100.00) from open 100.00
  });
});

// --- dealer-queued close (accept, requote accept, desk-off flush all use executeQueuedCloseInTx) -----------------------

describe("dealer-queued close", () => {
  it("partial then full both write the structured fields through executeQueuedCloseInTx", async () => {
    if (!dbReachable) return;
    const { queueCloseInTx, executeQueuedCloseInTx } = await import("@/lib/queued-close");
    const fx = await fixture({ dealing: true });
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00", swap: "2.00" });
    const run = async (lots: string, price: string) => {
      const cur = await pos(p.id);
      const order = await prisma.$transaction((tx) =>
        queueCloseInTx(tx, { brokerId: fx.brokerId, accountId: fx.accountId, position: { id: p.id, symbolId: fx.symbolId, side: "BUY", volume: cur.volume }, closeVolume: D(lots), requestedPrice: price, idempotencyKey: `q:${randomUUID()}`, source: "WEB", symbolName: fx.symbolName, accountNumber: fx.accountNumber, note: "x" })
      );
      const full = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      return prisma.$transaction((tx) => executeQueuedCloseInTx(tx, { order: full, fromStatus: "PENDING", closePrice: D(price), note: "Dealer close (at market)" }));
    };
    expect((await run("0.25", "100")).kind).toBe("closed");
    expect((await run("0.75", "102")).kind).toBe("closed");
    const rows = await pnlRows(p.id);
    expect(rows.map((r) => [r.closeVolume?.toString(), r.closePrice?.toString(), r.closeSwap?.toString(), r.closeByPositionId])).toEqual([
      ["0.25", "100", "0.5", null],
      ["0.75", "102", "1.5", null],
    ]);
    const done = await pos(p.id);
    expect(done.realizedPnl?.toString()).toBe("11.5"); // 0.25*(100-90) + 0.75*(102-90)
    expect(done.closedVolume?.toString()).toBe("1");
  });
});

// --- staff close -----------------------------------------------------------------------------------------------------

describe("staff close (executeAdminCloseInTx)", () => {
  it("partial then full", async () => {
    if (!dbReachable) return;
    const { executeAdminCloseInTx } = await import("@/lib/position-actions");
    const fx = await fixture();
    const p = await open(fx, { side: "SELL", volume: "2.00", openPrice: "110.00", swap: "-4.00" });
    const run = async (lots: string, price: string) => {
      const cur = await pos(p.id);
      return prisma.$transaction((tx) =>
        executeAdminCloseInTx(tx, { brokerId: fx.brokerId, adminId: fx.adminId, position: { id: p.id, accountId: fx.accountId, side: "SELL", openPrice: cur.openPrice, volume: cur.volume, symbol: { name: fx.symbolName, contractSize: D(1) }, account: { accountNumber: fx.accountNumber } }, closePrice: D(price), closeVolume: D(lots) })
      );
    };
    expect((await run("0.50", "100")).closed).toBe(true);
    expect((await run("1.50", "104")).closed).toBe(true);
    const rows = await pnlRows(p.id);
    expect(rows.map((r) => [r.closeVolume?.toString(), r.closePrice?.toString(), r.closeSwap?.toString(), r.note?.startsWith("Manual")])).toEqual([
      ["0.5", "100", "-1", true],
      ["1.5", "104", "-3", true],
    ]);
    const done = await pos(p.id);
    expect(done.realizedPnl?.toString()).toBe("14"); // 0.5*(110-100) + 1.5*(110-104)
    expect(done.closedVolume?.toString()).toBe("2");
  });
});

// --- bulk close ------------------------------------------------------------------------------------------------------

describe("bulk close", () => {
  it("writes the structured fields on every closed position", async () => {
    if (!dbReachable) return;
    const { closeBulkForAccount } = await import("@/lib/bulk-close");
    const fx = await fixture();
    const a = await open(fx, { side: "BUY", volume: "1.50", openPrice: "90.00", swap: "1.00" });
    const b = await open(fx, { side: "SELL", volume: "0.50", openPrice: "110.00" });
    const results = await closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "ALL" });
    expect(results.filter((r) => r.closed)).toHaveLength(2);
    const [ra] = await pnlRows(a.id);
    const [rb] = await pnlRows(b.id);
    expect([ra.closeVolume?.toString(), ra.closePrice?.toString(), ra.closeSwap?.toString()]).toEqual(["1.5", "100", "1"]);
    expect([rb.closeVolume?.toString(), rb.closePrice?.toString()]).toEqual(["0.5", "100.1"]);
    expect((await pos(a.id)).closedVolume?.toString()).toBe("1.5");
    expect((await pos(b.id)).realizedPnl?.toString()).toBe("4.95"); // (110 - 100.1) * 0.5
  });
});

// --- SL / TP / stop-out (risk monitor) -----------------------------------------------------------------------------------

describe("risk monitor closes", () => {
  it("stop loss", async () => {
    if (!dbReachable) return;
    const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "100.00", sl: "95.00", swap: "-1.00" });
    await setPrice(fx, "94.00", "94.10");
    const r = await evaluateAccountRisk(fx.accountId);
    expect(r.slTpClosed).toEqual([p.id]);
    const [row] = await pnlRows(p.id);
    expect([row.closeVolume?.toString(), row.closePrice?.toString(), row.closeSwap?.toString(), row.note]).toEqual(["1", "94", "-1", "Stop loss hit (automatic)"]);
    expect((await pos(p.id)).closedVolume?.toString()).toBe("1");
  });

  it("take profit", async () => {
    if (!dbReachable) return;
    const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "0.70", openPrice: "100.00", tp: "105.00" });
    await setPrice(fx, "106.00", "106.10");
    const r = await evaluateAccountRisk(fx.accountId);
    expect(r.slTpClosed).toEqual([p.id]);
    const [row] = await pnlRows(p.id);
    expect([row.closeVolume?.toString(), row.closePrice?.toString(), row.closeSwap?.toString()]).toEqual(["0.7", "106", "0"]);
    expect((await pos(p.id)).realizedPnl?.toString()).toBe("4.2");
  });

  it("SL after an earlier partial close takes only the remaining lots and the cumulative result", async () => {
    if (!dbReachable) return;
    const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "100.00", sl: "95.00", swap: "2.00" });
    await clientClose(fx, p.id, { volume: "0.50", closePrice: "100.00", maxSlippagePips: "5" });
    await setPrice(fx, "94.00", "94.10");
    await evaluateAccountRisk(fx.accountId);
    const rows = await pnlRows(p.id);
    expect(rows.map((r) => [r.closeVolume?.toString(), r.closeSwap?.toString()])).toEqual([["0.5", "1"], ["0.5", "1"]]);
    const done = await pos(p.id);
    expect(done.realizedPnl?.toString()).toBe("-3"); // 0 on the first half, (94-100)*0.5 on the second
    expect(done.closedVolume?.toString()).toBe("1");
  });

  it("stop-out", async () => {
    if (!dbReachable) return;
    const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
    const fx = await fixture({ balance: 60 });
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "100.00", swap: "-0.60" });
    await setPrice(fx, "70.00", "70.10"); // leverage 1: equity 30 / margin 70 = 43 %, at or below the 50 % stop-out
    const r = await evaluateAccountRisk(fx.accountId);
    expect(r.stopOutClosed).toEqual([p.id]);
    const [row] = await pnlRows(p.id);
    expect([row.closeVolume?.toString(), row.closePrice?.toString(), row.closeSwap?.toString()]).toEqual(["1", "70", "-0.6"]);
    expect(row.note).toMatch(/^Stop-out/);
    expect((await pos(p.id)).realizedPnl?.toString()).toBe("-30");
  });
});

// --- close-by --------------------------------------------------------------------------------------------------------

describe("close-by", () => {
  it("client instant, unequal legs: both rows carry the other leg's id, the larger leg is a partial", async () => {
    if (!dbReachable) return;
    const { closePositionsByEachOther } = await import("@/lib/close-by");
    const fx = await fixture();
    const buy = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00", swap: "5.00" });
    const sell = await open(fx, { side: "SELL", volume: "0.40", openPrice: "110.00", swap: "1.00" });
    const r = await closePositionsByEachOther(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, positionId: buy.id, againstPositionId: sell.id });
    expect(r.ok).toBe(true);
    const [ra] = await pnlRows(buy.id);
    const [rb] = await pnlRows(sell.id);
    expect([ra.closeVolume?.toString(), ra.closePrice?.toString(), ra.closeByPositionId, ra.closeSwap?.toString()]).toEqual(["0.4", "100.05", sell.id, "2"]);
    expect([rb.closeVolume?.toString(), rb.closePrice?.toString(), rb.closeByPositionId, rb.closeSwap?.toString()]).toEqual(["0.4", "100.05", buy.id, "1"]);
    const a = await pos(buy.id);
    expect(a.status).toBe("OPEN");
    expect(a.volume.toString()).toBe("0.6");
    expect(a.closedVolume?.toString()).toBe("0.4");
    expect((await pos(sell.id)).status).toBe("CLOSED");
  });

  it("client instant, equal legs: both close fully and link each other", async () => {
    if (!dbReachable) return;
    const { closePositionsByEachOther } = await import("@/lib/close-by");
    const fx = await fixture();
    const buy = await open(fx, { side: "BUY", volume: "0.53", openPrice: "100.00" });
    const sell = await open(fx, { side: "SELL", volume: "0.53", openPrice: "101.00" });
    const r = await closePositionsByEachOther(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, positionId: buy.id, againstPositionId: sell.id });
    expect(r.ok).toBe(true);
    const [ra] = await pnlRows(buy.id);
    const [rb] = await pnlRows(sell.id);
    expect(ra.closeByPositionId).toBe(sell.id);
    expect(rb.closeByPositionId).toBe(buy.id);
    expect((await pos(buy.id)).status).toBe("CLOSED");
    expect((await pos(sell.id)).closedVolume?.toString()).toBe("0.53");
  });

  it("client dealer-queued: the link is on both queued Orders and survives execution", async () => {
    if (!dbReachable) return;
    const { executeQueuedCloseInTx } = await import("@/lib/queued-close");
    const { getAccountSession } = await import("@/lib/account-auth");
    const fx = await fixture({ dealing: true });
    const buy = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    const sell = await open(fx, { side: "SELL", volume: "0.40", openPrice: "110.00" });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
    const { POST } = await import("@/app/api/trade/positions/close-by/route");
    const res = await POST(new NextRequest("https://test.local/api/trade/positions/close-by", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ positionId: buy.id, againstPositionId: sell.id }) }));
    expect(res.status).toBe(202);
    const json = await res.json();
    const oa = await prisma.order.findUniqueOrThrow({ where: { id: json.orderAId } });
    const ob = await prisma.order.findUniqueOrThrow({ where: { id: json.orderBId } });
    expect(oa.closeByPositionId).toBe(sell.id);
    expect(ob.closeByPositionId).toBe(buy.id);
    for (const order of [oa, ob]) {
      const out = await prisma.$transaction((tx) => executeQueuedCloseInTx(tx, { order, fromStatus: "PENDING", closePrice: D("100.05"), note: "Dealer close (at requested price)" }));
      expect(out.kind).toBe("closed");
    }
    const [ra] = await pnlRows(buy.id);
    const [rb] = await pnlRows(sell.id);
    expect([ra.closeVolume?.toString(), ra.closeByPositionId]).toEqual(["0.4", sell.id]);
    expect([rb.closeVolume?.toString(), rb.closeByPositionId]).toEqual(["0.4", buy.id]);
  });

  it("staff close-by: both rows link by id", async () => {
    if (!dbReachable) return;
    const { getAdminSession } = await import("@/lib/auth");
    const fx = await fixture();
    const buy = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    const sell = await open(fx, { side: "SELL", volume: "0.40", openPrice: "110.00" });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, brokerId: fx.brokerId, role: "BROKER_ADMIN" } as never);
    const { POST } = await import("@/app/api/manage/positions/close-by/route");
    const res = await POST(new NextRequest("https://test.local/api/manage/positions/close-by", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ positionId: buy.id, againstPositionId: sell.id }) }));
    expect(res.status).toBe(200);
    const [ra] = await pnlRows(buy.id);
    const [rb] = await pnlRows(sell.id);
    expect([ra.closeVolume?.toString(), ra.closePrice?.toString(), ra.closeByPositionId]).toEqual(["0.4", "100.05", sell.id]);
    expect([rb.closeVolume?.toString(), rb.closeByPositionId]).toEqual(["0.4", buy.id]);
  });
});

// --- mirror, coverage, reverse -----------------------------------------------------------------------------------------

describe("mirror close", () => {
  it("a proportional partial close of the copy writes lots and price", async () => {
    if (!dbReachable) return;
    const { onClose } = await import("@/lib/mirror");
    const fx = await fixture();
    const targetGroup = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `T-${randomUUID().slice(0, 8)}`, dealingMode: "AUTO" } });
    const target = await prisma.account.create({ data: { groupId: targetGroup.id, brokerId: fx.brokerId, accountNumber: `5${randomUUID().replace(/-/g, "").slice(0, 7)}`, email: `m-${randomUUID()}@test.local`, passwordHash: "x", fullName: "Master", accountMode: "LIVE", balance: D(100000) } });
    const rule = await prisma.mirrorRule.create({ data: { brokerId: fx.brokerId, sourceType: "GROUP", sourceId: fx.groupId, targetAccountId: target.id, direction: "REVERSE", multiplier: D(1), enabled: true, fillPriceMode: "SOURCE_PRICE", createdById: fx.adminId } });
    const copy = await open(fx, { side: "SELL", volume: "1.00", openPrice: "100.00", accountId: target.id, swap: "2.00" });
    const sourceId = randomUUID();
    await prisma.mirrorLink.create({ data: { ruleId: rule.id, sourcePositionId: sourceId, targetPositionId: copy.id } });
    await onClose(prisma, { positionId: sourceId, brokerId: fx.brokerId, closedLots: D("0.25"), sourceVolumeBeforeClose: D("1.00"), closePrice: D("98") }, { rethrow: true });
    const [row] = await pnlRows(copy.id);
    expect([row.closeVolume?.toString(), row.closePrice?.toString(), row.closeSwap?.toString(), row.amount.toString()]).toEqual(["0.25", "98", "0.5", "0.5"]);
    const after = await pos(copy.id);
    expect([after.status, after.volume.toString(), after.closedVolume?.toString(), after.realizedPnl?.toString()]).toEqual(["OPEN", "0.75", "0.25", "0.5"]);
    // and the rest
    await onClose(prisma, { positionId: sourceId, brokerId: fx.brokerId, closedLots: D("0.75"), sourceVolumeBeforeClose: D("0.75"), closePrice: D("97") }, { rethrow: true });
    const done = await pos(copy.id);
    expect([done.status, done.closedVolume?.toString(), done.realizedPnl?.toString(), done.closedSwap?.toString()]).toEqual(["CLOSED", "1", "2.75", "2"]);
  });
});

describe("coverage auto-close", () => {
  it("the auto-hedged leg's follow-up close writes the structured fields (partial then full)", async () => {
    if (!dbReachable) return;
    const { onClose } = await import("@/lib/coverage");
    const fx = await fixture();
    const covGroup = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `Cov-${randomUUID().slice(0, 8)}`, category: "COVERAGE", groupType: "COVERAGE", leverage: 500 } });
    const cov = await prisma.account.create({ data: { groupId: covGroup.id, brokerId: fx.brokerId, accountNumber: `4${randomUUID().replace(/-/g, "").slice(0, 7)}`, email: `cov-${randomUUID()}@test.local`, passwordHash: "x", fullName: "Dealer Coverage", accountMode: "LIVE", balance: D(0) } });
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { coverageAccountId: cov.id } });
    const client = await open(fx, { side: "BUY", volume: "2.00", openPrice: "100.00" });
    const leg = await open(fx, { side: "BUY", volume: "2.00", openPrice: "100.00", accountId: cov.id, swap: "1.00" });
    await prisma.position.update({ where: { id: leg.id }, data: { autoHedged: true, bookType: "A_BOOK" } });
    await prisma.position.update({ where: { id: client.id }, data: { covered: true, coveredAt: new Date(), coveragePositionId: leg.id, volume: D("1.50") } });
    await onClose(prisma, { positionId: client.id, brokerId: fx.brokerId, closedLots: D("0.50"), sourceVolumeBeforeClose: D("2.00"), reason: "manual" });
    const [p1] = await pnlRows(leg.id);
    expect([p1.closeVolume?.toString(), p1.closePrice?.toString(), p1.closeSwap?.toString(), p1.note?.startsWith("Coverage auto-close")]).toEqual(["0.5", "100", "0.25", true]);
    const mid = await pos(leg.id);
    expect([mid.status, mid.volume.toString(), mid.closedVolume?.toString()]).toEqual(["OPEN", "1.5", "0.5"]);
    await prisma.position.update({ where: { id: client.id }, data: { status: "CLOSED", closePrice: D("100"), closedAt: new Date() } });
    await onClose(prisma, { positionId: client.id, brokerId: fx.brokerId, closedLots: D("1.50"), sourceVolumeBeforeClose: D("1.50"), reason: "manual" });
    const rows = await pnlRows(leg.id);
    expect(rows.map((r) => [r.closeVolume?.toString(), r.closeSwap?.toString()])).toEqual([["0.5", "0.25"], ["1.5", "0.75"]]);
    expect((await pos(leg.id)).closedVolume?.toString()).toBe("2");
  });
});

describe("reverse close-and-reopen", () => {
  it("the closed leg carries the structured fields", async () => {
    if (!dbReachable) return;
    const { executeReverseCloseReopen } = await import("@/lib/position-actions");
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "0.80", openPrice: "90.00", swap: "-1.60" });
    const r = await prisma.$transaction((tx) => executeReverseCloseReopen(tx, { brokerId: fx.brokerId, positionId: p.id, adminId: fx.adminId }));
    expect(r.kind).toBe("REVERSE_CLOSE_REOPEN");
    const [row] = await pnlRows(p.id);
    expect([row.closeVolume?.toString(), row.closePrice?.toString(), row.closeSwap?.toString(), row.note?.startsWith("Reversed")]).toEqual(["0.8", "100", "-1.6", true]);
    const done = await pos(p.id);
    expect([done.status, done.closedVolume?.toString(), done.realizedPnl?.toString()]).toEqual(["CLOSED", "0.8", "8"]);
  });
});

// --- readers ---------------------------------------------------------------------------------------------------------

describe("history closes from the structured fields", () => {
  it("a staff partial (which the note parser could not read) now yields closes[]", async () => {
    if (!dbReachable) return;
    const { executeAdminCloseInTx } = await import("@/lib/position-actions");
    const { getAccountSession } = await import("@/lib/account-auth");
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    const run = (lots: string, price: string) =>
      prisma.$transaction(async (tx) => {
        const cur = await tx.position.findUniqueOrThrow({ where: { id: p.id } });
        return executeAdminCloseInTx(tx, { brokerId: fx.brokerId, adminId: fx.adminId, position: { id: p.id, accountId: fx.accountId, side: "BUY", openPrice: cur.openPrice, volume: cur.volume, symbol: { name: fx.symbolName, contractSize: D(1) }, account: { accountNumber: fx.accountNumber } }, closePrice: D(price), closeVolume: D(lots) });
      });
    await run("0.30", "100");
    await run("0.70", "101");
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
    const { GET } = await import("@/app/api/trade/history/route");
    const res = await GET(new NextRequest("https://test.local/api/trade/history"));
    const body = await res.json();
    const row = body.find((t: { id: string }) => t.id === p.id);
    expect(row.closedVolume).toBe("1");
    expect(row.closes.map((c: { volume: string; price: string; pnl: string; final: boolean }) => [c.volume, c.price, c.pnl, c.final])).toEqual([
      ["0.3", "100", "3", false],
      ["0.7", "101", "7.7", true],
    ]);
  });

  it("a close-by leg names the counterpart ticket by id", async () => {
    if (!dbReachable) return;
    const { closePositionsByEachOther } = await import("@/lib/close-by");
    const { getAccountSession } = await import("@/lib/account-auth");
    const fx = await fixture();
    const buy = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    const sell = await open(fx, { side: "SELL", volume: "0.40", openPrice: "110.00" });
    await closePositionsByEachOther(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, positionId: buy.id, againstPositionId: sell.id });
    await clientClose(fx, buy.id, { closePrice: "100.00", maxSlippagePips: "5" });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
    const { GET } = await import("@/app/api/trade/history/route");
    const body = await (await GET(new NextRequest("https://test.local/api/trade/history"))).json();
    const a = body.find((t: { id: string }) => t.id === buy.id);
    expect(a.closes.map((c: { volume: string; closedByTicket: number | null }) => [c.volume, c.closedByTicket])).toEqual([["0.4", sell.ticket], ["0.6", null]]);
    const b = body.find((t: { id: string }) => t.id === sell.id);
    expect(b.closes.map((c: { volume: string; closedByTicket: number | null }) => [c.volume, c.closedByTicket])).toEqual([["0.4", buy.ticket]]);
  });
});

describe("lots traded readers use closedVolume", () => {
  it("IB per-lot commission counts the cumulative closed lots, and the last piece for rows closed before the hotfix", async () => {
    if (!dbReachable) return;
    const { computePendingCommission } = await import("@/lib/commission");
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    await clientClose(fx, p.id, { volume: "0.40", closePrice: "100.00", maxSlippagePips: "5" });
    await clientClose(fx, p.id, { closePrice: "100.00", maxSlippagePips: "5" });
    const old = await open(fx, { side: "BUY", volume: "0.50", openPrice: "90.00" });
    await prisma.position.update({ where: { id: old.id }, data: { status: "CLOSED", closedAt: new Date(), closePrice: D("100"), realizedPnl: D("5") } }); // no closedVolume: legacy row
    const pending = await computePendingCommission(prisma, { clientAccountId: fx.accountId, commissionType: "PER_LOT", commissionRate: D(7), lastPayoutAt: null });
    expect(pending.toString()).toBe("10.5"); // (1.00 + 0.50) lots * 7
  });

  it("/api/manage/deals returns the lots traded as volume and exposes closedVolume", async () => {
    if (!dbReachable) return;
    const { getAdminSession } = await import("@/lib/auth");
    const fx = await fixture();
    const p = await open(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    await clientClose(fx, p.id, { volume: "0.40", closePrice: "100.00", maxSlippagePips: "5" });
    await clientClose(fx, p.id, { closePrice: "100.00", maxSlippagePips: "5" });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, brokerId: fx.brokerId, role: "BROKER_ADMIN" } as never);
    const { GET } = await import("@/app/api/manage/deals/route");
    const rows = await (await GET(new NextRequest(`https://test.local/api/manage/deals?accountId=${fx.accountId}`))).json();
    const row = rows.find((r: { id: string }) => r.id === p.id);
    expect([row.volume, row.closedVolume, row.realizedPnl]).toEqual(["1", "1", "10.00"]);
  });
});

describe("closeReasonFromNote", () => {
  it("maps staff partials, coverage and mirror closes", async () => {
    const { closeReasonFromNote } = await import("@/lib/dealer-activity");
    expect(closeReasonFromNote("Manual partial close by admin: 0.5 lots @ 100")).toBe("ADMIN");
    expect(closeReasonFromNote("Manual close by admin @ 100")).toBe("ADMIN");
    expect(closeReasonFromNote("Coverage auto-close (auto-hedged leg): client #1 closed 1 of 2")).toBe("COVERAGE");
    expect(closeReasonFromNote("Mirror close (rule r, source position p, mode SOURCE_PRICE)")).toBe("MIRROR");
    expect(closeReasonFromNote("Reversed (close & reopen) by admin @ 100")).toBe("ADMIN");
    expect(closeReasonFromNote("Partial close: 0.5 lots @ 100")).toBe("MANUAL");
    expect(closeReasonFromNote(null)).toBe("MANUAL");
  });
});
