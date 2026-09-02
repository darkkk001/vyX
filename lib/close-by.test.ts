import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Same reasoning as lib/bulk-close.test.ts's own mock -- avoid a real
// outbound HTTP call to the gateway on every close.
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const { closePositionsByEachOther } = await import("@/lib/close-by");

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/close-by.test.ts: DB unreachable, skipping");
  }
});

class RollbackSignal extends Error {}
async function withRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new RollbackSignal();
      },
      { timeout: 60000, maxWait: 60000 }
    );
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
}

type Fixture = { brokerId: string; accountId: string; xauSymbolId: string; eurSymbolId: string };

// Same reasoning as lib/bulk-close.test.ts's own fixture comment -- reuse
// the real, already-live-ticking XAUUSD/EURUSD Symbol rows so
// lib/live-price.ts's getFreshPrices (which reads through the top-level
// prisma singleton, not this test's own uncommitted transaction) sees a
// real price.
async function createFixture(tx: Prisma.TransactionClient): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await tx.broker.create({ data: { name: `Close By Test ${suffix}`, subdomain: `cbtest-${suffix}` } });
  const [xau, eur] = await Promise.all([
    tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } }),
    tx.symbol.findUniqueOrThrow({ where: { name: "EURUSD" } }),
  ]);
  await tx.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: xau.id, minLot: D(0.01), maxLot: D(1000), lotStep: D(0.01), tradingMode: "BOTH" } });
  await tx.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: eur.id, minLot: D(0.01), maxLot: D(1000), lotStep: D(0.01), tradingMode: "BOTH" } });
  const account = await tx.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `7${suffix.slice(0, 7)}`,
      email: `cb-client-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Close By Test Client",
      accountType: "LIVE",
      balance: D(1_000_000),
    },
  });
  return { brokerId: broker.id, accountId: account.id, xauSymbolId: xau.id, eurSymbolId: eur.id };
}

async function createOpenPosition(
  tx: Prisma.TransactionClient,
  fx: Fixture,
  params: { symbolId: string; side: "BUY" | "SELL"; volume: string; openPrice: string }
) {
  const order = await tx.order.create({
    data: {
      brokerId: fx.brokerId,
      accountId: fx.accountId,
      symbolId: params.symbolId,
      side: params.side,
      type: "MARKET",
      volume: D(params.volume),
      status: "FILLED",
      filledPrice: D(params.openPrice),
      filledAt: new Date(),
      idempotencyKey: `cb-test:${randomUUID()}`,
    },
  });
  return tx.position.create({
    data: {
      brokerId: fx.brokerId,
      accountId: fx.accountId,
      symbolId: params.symbolId,
      originOrderId: order.id,
      side: params.side,
      volume: D(params.volume),
      openPrice: D(params.openPrice),
      status: "OPEN",
    },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("closePositionsByEachOther (live DB, rolled back)", () => {
  it("nets the smaller of two opposite positions fully, leaves the larger open with reduced volume", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const buy = await createOpenPosition(tx, fx, { symbolId: fx.xauSymbolId, side: "BUY", volume: "1.00", openPrice: "4000.00" });
      const sell = await createOpenPosition(tx, fx, { symbolId: fx.xauSymbolId, side: "SELL", volume: "0.40", openPrice: "4050.00" });

      const result = await closePositionsByEachOther(tx, { accountId: fx.accountId, brokerId: fx.brokerId, positionId: buy.id, againstPositionId: sell.id });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.closeVolume).toBe("0.4");
      // The smaller leg (SELL 0.40) closes fully.
      const sellAfter = await tx.position.findUniqueOrThrow({ where: { id: sell.id } });
      expect(sellAfter.status).toBe("CLOSED");
      // The larger leg (BUY 1.00) stays open, reduced by the netted volume.
      const buyAfter = await tx.position.findUniqueOrThrow({ where: { id: buy.id } });
      expect(buyAfter.status).toBe("OPEN");
      expect(buyAfter.volume.toString()).toBe("0.6");

      // Both legs closed at the exact same single price.
      expect(result.closePrice).toBeTruthy();

      // Combined realized P&L to the account matches the economically
      // fixed total (independent of which reference price was used) --
      // (sellOpen - buyOpen) * closeVolume * contractSize:
      // (4050 - 4000) * 0.4 * 100 (XAUUSD's contract size) = 2000.
      const combinedPnl = Number(result.realizedPnlA) + Number(result.realizedPnlB);
      expect(combinedPnl).toBeCloseTo(2000, 6);

      // Exactly one ledger row per leg -- a pair, not a bespoke combined row.
      const txCount = await tx.transaction.count({ where: { accountId: fx.accountId, type: "TRADE_PNL" } });
      expect(txCount).toBe(2);
    });
  }, 30000);

  it("closes both fully when volumes match exactly", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const buy = await createOpenPosition(tx, fx, { symbolId: fx.xauSymbolId, side: "BUY", volume: "0.50", openPrice: "4000.00" });
      const sell = await createOpenPosition(tx, fx, { symbolId: fx.xauSymbolId, side: "SELL", volume: "0.50", openPrice: "4010.00" });

      const result = await closePositionsByEachOther(tx, { accountId: fx.accountId, brokerId: fx.brokerId, positionId: buy.id, againstPositionId: sell.id });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.closeVolume).toBe("0.5");

      const buyAfter = await tx.position.findUniqueOrThrow({ where: { id: buy.id } });
      const sellAfter = await tx.position.findUniqueOrThrow({ where: { id: sell.id } });
      expect(buyAfter.status).toBe("CLOSED");
      expect(sellAfter.status).toBe("CLOSED");
    });
  }, 30000);

  it("rejects two positions on the same side", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const buyA = await createOpenPosition(tx, fx, { symbolId: fx.xauSymbolId, side: "BUY", volume: "0.10", openPrice: "4000.00" });
      const buyB = await createOpenPosition(tx, fx, { symbolId: fx.xauSymbolId, side: "BUY", volume: "0.10", openPrice: "4000.00" });

      const result = await closePositionsByEachOther(tx, { accountId: fx.accountId, brokerId: fx.brokerId, positionId: buyA.id, againstPositionId: buyB.id });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/opposite sides/);
    });
  });

  it("rejects positions on different symbols", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const xauBuy = await createOpenPosition(tx, fx, { symbolId: fx.xauSymbolId, side: "BUY", volume: "0.10", openPrice: "4000.00" });
      const eurSell = await createOpenPosition(tx, fx, { symbolId: fx.eurSymbolId, side: "SELL", volume: "0.10", openPrice: "1.10" });

      const result = await closePositionsByEachOther(tx, { accountId: fx.accountId, brokerId: fx.brokerId, positionId: xauBuy.id, againstPositionId: eurSell.id });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/same symbol/);
    });
  });

  it("rejects a position closed against itself", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const buy = await createOpenPosition(tx, fx, { symbolId: fx.xauSymbolId, side: "BUY", volume: "0.10", openPrice: "4000.00" });

      const result = await closePositionsByEachOther(tx, { accountId: fx.accountId, brokerId: fx.brokerId, positionId: buy.id, againstPositionId: buy.id });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/itself/);
    });
  });

  it("rejects a position that belongs to a different account", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const otherFx = await createFixture(tx);
      const buy = await createOpenPosition(tx, fx, { symbolId: fx.xauSymbolId, side: "BUY", volume: "0.10", openPrice: "4000.00" });
      const otherSell = await createOpenPosition(tx, otherFx, { symbolId: otherFx.xauSymbolId, side: "SELL", volume: "0.10", openPrice: "4000.00" });

      const result = await closePositionsByEachOther(tx, { accountId: fx.accountId, brokerId: fx.brokerId, positionId: buy.id, againstPositionId: otherSell.id });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/not found/);
    });
  });
});
