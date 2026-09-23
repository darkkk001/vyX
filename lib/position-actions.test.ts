import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { executeAdminCloseInTx, executeReverseCloseReopen } from "@/lib/position-actions";

// Money-path guards on the backoffice's own close paths (2026-09-23). The admin close route and the
// reverse (close & reopen) action each wrote the close with a bare update-by-id: no status guard (a
// double click or a race with the risk monitor credited the account twice) and no negative-balance
// protection (a deep loss closed by a dealer drove the balance below zero). Both now go through
// closePositionInTx, the one place a trade changes the balance.

const D = (v: string | number) => new Prisma.Decimal(v);

class RollbackSignal extends Error {}
async function withRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSignal();
    }, { timeout: 30_000 });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
}

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
    // executeReverseCloseReopen prices off LivePrice through the global client (committed rows only)
    await prisma.livePrice.update({ where: { symbol: "XAUUSD" }, data: { bid: D("3990.00"), ask: D("3990.50"), tickAt: new Date(), updatedAt: new Date() } });
  } catch {
    dbReachable = false;
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});

type Fixture = { brokerId: string; accountId: string; symbolId: string; adminId: string };

async function createFixture(tx: Prisma.TransactionClient, balance: string, nbp = true): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await tx.broker.create({ data: { name: `Position Actions Test ${suffix}`, subdomain: `patest-${suffix}`, negativeBalanceProtection: nbp } });
  const admin = await tx.adminUser.create({ data: { brokerId: broker.id, email: `pa-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
  const group = await tx.group.create({ data: { brokerId: broker.id, name: `PA-${suffix}`, dealingMode: "AUTO" } });
  const account = await tx.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: `8${suffix.slice(0, 7)}`, email: `pa-${suffix}@test.local`, passwordHash: "x", fullName: "Position Actions Test", accountMode: "LIVE", balance: D(balance) },
  });
  return { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, adminId: admin.id };
}

async function openPosition(tx: Prisma.TransactionClient, fx: Fixture, side: "BUY" | "SELL", volume: string, openPrice: string) {
  const order = await tx.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side, type: "MARKET", volume: D(volume), status: "FILLED", filledPrice: D(openPrice), filledAt: new Date(), idempotencyKey: `pa-test:${randomUUID()}` },
  });
  return tx.position.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side, volume: D(volume), openPrice: D(openPrice), status: "OPEN" },
    include: { symbol: { select: { name: true, contractSize: true } }, account: { select: { accountNumber: true } } },
  });
}

describe("executeAdminCloseInTx (live DB, rolled back)", () => {
  it("a second close from the same stale read is refused: one TRADE_PNL, the account credited once", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "100000");
      const snapshot = await openPosition(tx, fx, "BUY", "1.00", "4000.00");

      const first = await executeAdminCloseInTx(tx, { brokerId: fx.brokerId, adminId: fx.adminId, position: snapshot, closePrice: D("4010.00"), closeVolume: snapshot.volume });
      expect(first.closed).toBe(true);
      const second = await executeAdminCloseInTx(tx, { brokerId: fx.brokerId, adminId: fx.adminId, position: snapshot, closePrice: D("4050.00"), closeVolume: snapshot.volume });
      expect(second.closed).toBe(false);

      const acct = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.balance.toString()).toBe("101000");
      expect(await tx.transaction.count({ where: { accountId: fx.accountId, type: "TRADE_PNL" } })).toBe(1);
      expect(await tx.auditLog.count({ where: { entityId: snapshot.id, action: "MANUAL_POSITION_CLOSE" } })).toBe(1);
    });
  });

  it("a full close records the closing admin and the MANUAL_POSITION_CLOSE audit", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "100000");
      const snapshot = await openPosition(tx, fx, "SELL", "0.50", "4000.00");
      const r = await executeAdminCloseInTx(tx, { brokerId: fx.brokerId, adminId: fx.adminId, position: snapshot, closePrice: D("3990.00"), closeVolume: snapshot.volume });
      expect(r.closed).toBe(true);
      if (r.closed) expect(r.realizedPnl.toString()).toBe("500");
      const after = await tx.position.findUniqueOrThrow({ where: { id: snapshot.id } });
      expect(after.status).toBe("CLOSED");
      expect(after.closedByAdminId).toBe(fx.adminId);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { entityId: snapshot.id, action: "MANUAL_POSITION_CLOSE" } });
      expect(audit.actorAdminId).toBe(fx.adminId);
    });
  });

  it("a partial close keeps the position OPEN with the rest and does not stamp the closing admin", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "100000");
      const snapshot = await openPosition(tx, fx, "BUY", "1.00", "4000.00");
      const r = await executeAdminCloseInTx(tx, { brokerId: fx.brokerId, adminId: fx.adminId, position: snapshot, closePrice: D("4010.00"), closeVolume: D("0.30") });
      expect(r.closed && r.partial).toBe(true);
      const after = await tx.position.findUniqueOrThrow({ where: { id: snapshot.id } });
      expect(after.status).toBe("OPEN");
      expect(after.volume.toString()).toBe("0.7");
      expect(after.closedByAdminId).toBeNull();
    });
  });

  it("applies negative-balance protection: a loss deeper than the balance leaves 0 and a write-off row", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "50");
      const snapshot = await openPosition(tx, fx, "BUY", "1.00", "4000.00");
      const r = await executeAdminCloseInTx(tx, { brokerId: fx.brokerId, adminId: fx.adminId, position: snapshot, closePrice: D("3995.00"), closeVolume: snapshot.volume });
      expect(r.closed).toBe(true);
      const acct = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.balance.toString()).toBe("0"); // was 50 - 500 = -450 before the fix
      const nbp = await tx.transaction.findFirstOrThrow({ where: { accountId: fx.accountId, type: "NEGATIVE_BALANCE_PROTECTION" } });
      expect(nbp.amount.toString()).toBe("450");
    });
  });
});

describe("executeReverseCloseReopen (live DB, rolled back)", () => {
  it("applies negative-balance protection on the close leg and still opens the reversed position", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "50");
      const pos = await openPosition(tx, fx, "BUY", "1.00", "4000.00"); // closes at bid 3990.00: -1000
      let result;
      try {
        result = await executeReverseCloseReopen(tx, { brokerId: fx.brokerId, positionId: pos.id, adminId: fx.adminId });
      } catch (err) {
        // the default METALS session can be closed at the moment the suite runs; that is not what this test is about
        if (err instanceof Error && /Market closed/.test(err.message)) return;
        throw err;
      }
      expect(result.realizedPnl.toString()).toBe("-1000");
      const acct = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.balance.toString()).toBe("0");
      expect(await tx.transaction.count({ where: { accountId: fx.accountId, type: "NEGATIVE_BALANCE_PROTECTION" } })).toBe(1);
      const closed = await tx.position.findUniqueOrThrow({ where: { id: pos.id } });
      expect(closed.status).toBe("CLOSED");
      expect(closed.closedByAdminId).toBe(fx.adminId);
      expect(result.newPosition.side).toBe("SELL");
    });
  });
});
