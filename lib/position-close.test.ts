import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { closePositionInTx } from "@/lib/position-close";

// Phase 1 §4 (docs/ROADMAP.md's "position close") -- direct coverage of
// the one shared function every close site in this app funnels through
// (the single-close route, bulk-close, close-by, the risk monitor's own
// SL/TP/stop-out). lib/bulk-close.test.ts and lib/close-by.test.ts
// already exercise this indirectly; this file pins its own contract
// directly, including the double-close race guard neither of those
// happens to hit.

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/position-close.test.ts: DB unreachable, skipping");
  }
});

class RollbackSignal extends Error {}
async function withRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
}

type Fixture = { brokerId: string; accountId: string; symbolId: string };

async function createFixture(tx: Prisma.TransactionClient, balance = "100000"): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await tx.broker.create({ data: { name: `Position Close Test ${suffix}`, subdomain: `pctest-${suffix}` } });
  const symbol = await tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
  const account = await tx.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `9${suffix.slice(0, 7)}`,
      email: `pc-client-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Position Close Test",
      accountMode: "LIVE",
      balance: D(balance),
    },
  });
  return { brokerId: broker.id, accountId: account.id, symbolId: symbol.id };
}

async function createOpenPosition(
  tx: Prisma.TransactionClient,
  fx: Fixture,
  params: { side: "BUY" | "SELL"; volume: string; openPrice: string }
) {
  const order = await tx.order.create({
    data: {
      brokerId: fx.brokerId,
      accountId: fx.accountId,
      symbolId: fx.symbolId,
      side: params.side,
      type: "MARKET",
      volume: D(params.volume),
      status: "FILLED",
      filledPrice: D(params.openPrice),
      filledAt: new Date(),
      idempotencyKey: `pc-test:${randomUUID()}`,
    },
  });
  return tx.position.create({
    data: {
      brokerId: fx.brokerId,
      accountId: fx.accountId,
      symbolId: fx.symbolId,
      originOrderId: order.id,
      side: params.side,
      volume: D(params.volume),
      openPrice: D(params.openPrice),
      status: "OPEN",
    },
  });
}

const contractSizeArg = { contractSize: D("100") }; // XAUUSD

afterAll(async () => {
  await prisma.$disconnect();
});

describe("closePositionInTx (live DB, rolled back)", () => {
  it("fully closes a profitable BUY: sets CLOSED, credits the account, writes one TRADE_PNL row", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const pos = await createOpenPosition(tx, fx, { side: "BUY", volume: "1.00", openPrice: "4000.00" });

      const outcome = await closePositionInTx(tx, {
        position: { id: pos.id, accountId: fx.accountId, brokerId: fx.brokerId, side: "BUY", openPrice: D("4000.00"), volume: D("1.00"), symbol: contractSizeArg },
        closePrice: "4010.00",
      });

      expect(outcome.closed).toBe(true);
      if (!outcome.closed) return;
      expect(outcome.partial).toBe(false);
      expect(outcome.realizedPnl.toString()).toBe("1000"); // (4010-4000)*1.00*100

      const posAfter = await tx.position.findUniqueOrThrow({ where: { id: pos.id } });
      expect(posAfter.status).toBe("CLOSED");
      expect(posAfter.closePrice?.toString()).toBe("4010");

      const acctAfter = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acctAfter.balance.toString()).toBe("101000"); // 100000 + 1000

      const txCount = await tx.transaction.count({ where: { accountId: fx.accountId, type: "TRADE_PNL" } });
      expect(txCount).toBe(1);
    });
  });

  it("fully closes a losing SELL correctly (inverse P&L direction)", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const pos = await createOpenPosition(tx, fx, { side: "SELL", volume: "0.50", openPrice: "4000.00" });

      const outcome = await closePositionInTx(tx, {
        position: { id: pos.id, accountId: fx.accountId, brokerId: fx.brokerId, side: "SELL", openPrice: D("4000.00"), volume: D("0.50"), symbol: contractSizeArg },
        closePrice: "4020.00", // price rose -- a SELL loses
      });

      expect(outcome.closed).toBe(true);
      if (!outcome.closed) return;
      expect(outcome.realizedPnl.toString()).toBe("-1000"); // (4000-4020)*0.5*100

      const acctAfter = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acctAfter.balance.toString()).toBe("99000");
    });
  });

  it("a partial close reduces volume and keeps the position OPEN, rather than closing it outright", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const pos = await createOpenPosition(tx, fx, { side: "BUY", volume: "1.00", openPrice: "4000.00" });

      const outcome = await closePositionInTx(tx, {
        position: { id: pos.id, accountId: fx.accountId, brokerId: fx.brokerId, side: "BUY", openPrice: D("4000.00"), volume: D("1.00"), symbol: contractSizeArg },
        closePrice: "4010.00",
        closeVolume: D("0.40"),
      });

      expect(outcome.closed).toBe(true);
      if (!outcome.closed) return;
      expect(outcome.partial).toBe(true);
      expect(outcome.realizedPnl.toString()).toBe("400"); // (4010-4000)*0.4*100

      const posAfter = await tx.position.findUniqueOrThrow({ where: { id: pos.id } });
      expect(posAfter.status).toBe("OPEN"); // still open -- only reduced
      expect(posAfter.volume.toString()).toBe("0.6");
      expect(posAfter.closePrice).toBeNull(); // a partial close never stamps closePrice
    });
  });

  it("a second close attempt on an already-CLOSED position is a benign no-op, not a double credit", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const pos = await createOpenPosition(tx, fx, { side: "BUY", volume: "1.00", openPrice: "4000.00" });

      const first = await closePositionInTx(tx, {
        position: { id: pos.id, accountId: fx.accountId, brokerId: fx.brokerId, side: "BUY", openPrice: D("4000.00"), volume: D("1.00"), symbol: contractSizeArg },
        closePrice: "4010.00",
      });
      expect(first.closed).toBe(true);

      // Simulates a concurrent caller (another tab, the risk monitor's
      // stop-out) racing to close the same already-closed position --
      // the guarded UPDATE (status='OPEN' in the WHERE) must find zero
      // rows and report {closed:false}, never re-credit the account.
      const second = await closePositionInTx(tx, {
        position: { id: pos.id, accountId: fx.accountId, brokerId: fx.brokerId, side: "BUY", openPrice: D("4000.00"), volume: D("1.00"), symbol: contractSizeArg },
        closePrice: "4050.00",
      });
      expect(second.closed).toBe(false);

      const acctAfter = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acctAfter.balance.toString()).toBe("101000"); // only the first close's credit
      const txCount = await tx.transaction.count({ where: { accountId: fx.accountId, type: "TRADE_PNL" } });
      expect(txCount).toBe(1);
    });
  });

  it("uses the caller's supplied note verbatim when given, otherwise defaults based on partial/full", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const pos = await createOpenPosition(tx, fx, { side: "BUY", volume: "1.00", openPrice: "4000.00" });

      await closePositionInTx(tx, {
        position: { id: pos.id, accountId: fx.accountId, brokerId: fx.brokerId, side: "BUY", openPrice: D("4000.00"), volume: D("1.00"), symbol: contractSizeArg },
        closePrice: "4010.00",
        closeVolume: D("0.3"),
        note: "Bulk close (ALL)",
      });

      const txn = await tx.transaction.findFirstOrThrow({ where: { accountId: fx.accountId, type: "TRADE_PNL" } });
      expect(txn.note).toBe("Bulk close (ALL)");
    });
  });
});
