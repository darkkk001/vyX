import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkAccountPreTradeMargin, hedgedUsedMargin, type MarginLeg } from "@/lib/margin";
import { accountMarginLevel } from "@/lib/risk-monitor";

// MT5 hedged margin (2026-09-25): per symbol, the hedged BUY+SELL volume pays BrokerSymbol.hedgedMarginPct of one lot's
// margin per lot pair; the uncovered volume pays in full. 200 = the old plain sum.
const D = (v: string | number) => new Prisma.Decimal(v);
const leg = (symbolKey: string, side: "BUY" | "SELL", volume: string, margin: string, pct: string | number): MarginLeg => ({ symbolKey, side, volume: D(volume), margin: D(margin), hedgedMarginPct: D(pct) });

describe("hedgedUsedMargin (the canonical formula)", () => {
  it("200% = the plain sum (the behavior before hedged margin)", () => {
    expect(hedgedUsedMargin([leg("X", "BUY", "1", "100", 200), leg("X", "SELL", "1", "101", 200)]).toString()).toBe("201");
    expect(hedgedUsedMargin([leg("X", "BUY", "3", "300", 200), leg("X", "SELL", "1", "101", 200)]).toString()).toBe("401");
  });

  it("a fully hedged pair costs pct/200 of both legs: 100% = one lot, 50% = half a lot, 0% = free", () => {
    const pair = (pct: number) => hedgedUsedMargin([leg("X", "BUY", "1", "100", pct), leg("X", "SELL", "1", "101", pct)]).toString();
    expect(pair(100)).toBe("100.5");
    expect(pair(50)).toBe("50.25");
    expect(pair(0)).toBe("0");
  });

  it("only the hedged volume is reduced; the uncovered volume pays in full", () => {
    // BUY 3 (300) vs SELL 1 (101) at 50%: covered = 300*1/3 = 100 -> (300-100) + (101+100)*50/200 = 200 + 50.25
    expect(hedgedUsedMargin([leg("X", "BUY", "3", "300", 50), leg("X", "SELL", "1", "101", 50)]).toString()).toBe("250.25");
    // the larger side can be the SELL
    expect(hedgedUsedMargin([leg("X", "SELL", "2", "202", 0), leg("X", "BUY", "1", "100", 0)]).toString()).toBe("101");
  });

  it("symbols never hedge each other; one-sided books are the plain sum", () => {
    expect(hedgedUsedMargin([leg("X", "BUY", "1", "100", 0), leg("Y", "SELL", "1", "50", 0)]).toString()).toBe("150");
    expect(hedgedUsedMargin([leg("X", "BUY", "1", "100", 0), leg("X", "BUY", "2", "200", 0)]).toString()).toBe("300");
    expect(hedgedUsedMargin([]).toString()).toBe("0");
  });
});

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("hedged-margin.test.ts: DB unreachable, skipping DB cases"); }
});
const brokerIds: string[] = [];
const symbolNames: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokerIds } };
  await prisma.position.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.brokerSymbol.deleteMany({ where });
  await prisma.group.deleteMany({ where });
  await prisma.broker.deleteMany({ where: { id: { in: brokerIds } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbolNames } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbolNames } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

// XAU-like: contract 100, price 2000/2000.20, leverage 100 -> one BUY lot = 100*2000/100 = 2000, one SELL lot = 2000.2
async function fixture(pct: number, balance: string) {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Hedged ${s}`, subdomain: `hm-${s}` } });
  brokerIds.push(broker.id);
  const symbol = await prisma.symbol.create({ data: { name: `HM${s.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  symbolNames.push(symbol.name);
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, hedgedMarginPct: D(pct), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("2000.00"), ask: D("2000.20"), tickAt: new Date() } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `G-${s}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50) } });
  const account = await prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: `4${s.slice(0, 7)}`, email: `hm-${s}@test.local`, passwordHash: "x", fullName: "Hedger", accountMode: "LIVE", balance: D(balance), leverage: 100 } });
  return { brokerId: broker.id, symbolId: symbol.id, accountId: account.id };
}
async function open(fx: Awaited<ReturnType<typeof fixture>>, side: "BUY" | "SELL", volume: string, openPrice: string) {
  const order = await prisma.order.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side, type: "MARKET", volume: D(volume), requestedPrice: D(openPrice), idempotencyKey: `hm:${randomUUID()}`, status: "FILLED", filledPrice: D(openPrice), filledAt: new Date() } });
  return prisma.position.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side, volume: D(volume), openPrice: D(openPrice) } });
}
const sellOrder = (fx: Awaited<ReturnType<typeof fixture>>) =>
  checkAccountPreTradeMargin(prisma, { accountId: fx.accountId, leverage: 100, marginCallLevel: D(100), newOrderContractSize: D(100), newOrderVolume: D(1), newOrderFillPrice: D("2000.00"), newOrderQuoteCurrency: "USD", newOrderSide: "SELL", newOrderSymbolId: fx.symbolId });

describe("pre-trade: an order is judged on how it CHANGES the hedged margin (MT5)", () => {
  it("at 200% a hedging SELL needs full margin and is refused on a thin account (today's behavior)", async () => {
    if (!dbReachable) return;
    const fx = await fixture(200, "3000");
    await open(fx, "BUY", "1", "2000.00");
    const r = await sellOrder(fx);
    expect(r?.error).toBe("INSUFFICIENT_MARGIN");
    expect(r?.required).toBe("2000.00");
  });

  it("at 50% the same SELL hedges: used margin goes DOWN, so it is always allowed", async () => {
    if (!dbReachable) return;
    const fx = await fixture(50, "3000");
    await open(fx, "BUY", "1", "2000.00");
    expect(await sellOrder(fx)).toBeNull();
  });

  it("at 100% it adds nothing (only the larger side) and is allowed even at a low level", async () => {
    if (!dbReachable) return;
    const fx = await fixture(100, "1500");   // level 75% before: below margin call already
    await open(fx, "BUY", "1", "2000.00");
    expect(await sellOrder(fx)).toBeNull();
  });
});

describe("stop-out measures the hedged margin", () => {
  it("a hedged pair at 50% has half the used margin of the same pair at 200%", async () => {
    if (!dbReachable) return;
    const a = await fixture(200, "5000");
    await open(a, "BUY", "1", "2000.00"); await open(a, "SELL", "1", "2000.00");
    const b = await fixture(50, "5000");
    await open(b, "BUY", "1", "2000.00"); await open(b, "SELL", "1", "2000.00");
    // equity 5000 - 20 (the SELL closes at the ask: 0.20 x contract 100) = 4980; margin 4000.2 at 200%, 1000.05 at 50%
    expect((await accountMarginLevel(a.accountId))!.toFixed(4)).toBe(D("4980").div("4000.2").mul(100).toFixed(4));
    expect((await accountMarginLevel(b.accountId))!.toFixed(4)).toBe(D("4980").div("1000.05").mul(100).toFixed(4));
  });
});

describe("WebTrader's display copy agrees with the server formula", () => {
  it("same result on mixed books", async () => {
    const { hedgedUsedMarginDisplay } = await import("@/lib/hedged-margin-display");
    const books: MarginLeg[][] = [
      [leg("X", "BUY", "3", "300", 50), leg("X", "SELL", "1", "101", 50)],
      [leg("X", "SELL", "2", "202", 0), leg("X", "BUY", "1", "100", 0), leg("Y", "BUY", "0.5", "42.5", 100), leg("Y", "SELL", "0.25", "21.3", 100)],
      [leg("X", "BUY", "1", "100", 200), leg("X", "SELL", "1", "101", 200)],
    ];
    for (const book of books) {
      const server = hedgedUsedMargin(book).toNumber();
      const client = hedgedUsedMarginDisplay(book.map((l) => ({ symbolKey: l.symbolKey, side: l.side, volume: l.volume.toNumber(), margin: l.margin.toNumber(), hedgedMarginPct: l.hedgedMarginPct.toNumber() })));
      expect(client).toBeCloseTo(server, 9);
    }
  });
});
