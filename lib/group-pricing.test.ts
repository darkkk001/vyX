import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveBookType, pipSize, applySpreadMarkup, resolveSymbolPricing, chargeCommission } from "@/lib/group-pricing";

// Phase 1 §4 (docs/ROADMAP.md's "orders route: fill price") -- these are
// the pure functions the order routes actually use to compute what a
// trader's fill price and commission charge are; group-pricing.ts had no
// test file at all before this.

const D = (v: string | number) => new Prisma.Decimal(v);

describe("resolveBookType", () => {
  it("routes an LP group to A_BOOK, everything else to B_BOOK", () => {
    expect(resolveBookType("LP")).toBe("A_BOOK");
    expect(resolveBookType("DEALING")).toBe("B_BOOK");
    expect(resolveBookType("DEMO")).toBe("B_BOOK");
  });
});

describe("pipSize", () => {
  it("matches engine/order-management/src/pricing.rs's own pip_size formula", () => {
    expect(pipSize(5).toString()).toBe("0.0001"); // 5-digit FX (EURUSD) -- pip is the 4th decimal
    expect(pipSize(2).toString()).toBe("0.1"); // 2-digit metals (XAUUSD)
    expect(pipSize(1).toString()).toBe("1"); // 1-digit indices
    expect(pipSize(0).toString()).toBe("1"); // never negative exponent
  });
});

describe("applySpreadMarkup", () => {
  it("widens a BUY fill by spreadMarkup pips, leaves a SELL fill untouched", () => {
    const buyPrice = applySpreadMarkup({ side: "BUY", price: "1.10000", spreadMarkup: "2", digits: 5 });
    expect(buyPrice.toString()).toBe("1.1002"); // +2 pips = +0.0002

    const sellPrice = applySpreadMarkup({ side: "SELL", price: "1.10000", spreadMarkup: "2", digits: 5 });
    expect(sellPrice.toString()).toBe("1.1"); // unaffected -- ask-only markup convention
  });

  it("a zero markup returns the price unchanged for either side", () => {
    expect(applySpreadMarkup({ side: "BUY", price: "4000.00", spreadMarkup: "0", digits: 2 }).toString()).toBe("4000");
    expect(applySpreadMarkup({ side: "SELL", price: "4000.00", spreadMarkup: "0", digits: 2 }).toString()).toBe("4000");
  });

  it("accepts number/Decimal price inputs identically to string", () => {
    const fromString = applySpreadMarkup({ side: "BUY", price: "4000.00", spreadMarkup: "1.5", digits: 2 });
    const fromNumber = applySpreadMarkup({ side: "BUY", price: 4000.0, spreadMarkup: 1.5, digits: 2 });
    expect(fromString.toString()).toBe(fromNumber.toString());
  });
});

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/group-pricing.test.ts: DB unreachable, skipping DB-backed tests");
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

afterAll(async () => {
  await prisma.$disconnect();
});

describe("resolveSymbolPricing (live DB, rolled back)", () => {
  it("falls back to the broker-wide rate when the account has no group", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const symbol = await tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
      const pricing = await resolveSymbolPricing(tx, {
        groupId: null,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
      });
      expect(pricing.spreadMarkup.toString()).toBe("3");
      expect(pricing.commissionPerLot.toString()).toBe("7");
    });
  });

  it("falls back to the broker-wide rate when the group has no override row for this symbol", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
      const broker = await tx.broker.create({ data: { name: `Pricing Test ${suffix}`, subdomain: `gptest-${suffix}` } });
      const group = await tx.group.create({ data: { brokerId: broker.id, name: "No Override Group", leverage: 100 } });
      const symbol = await tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });

      const pricing = await resolveSymbolPricing(tx, {
        groupId: group.id,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
      });
      expect(pricing.spreadMarkup.toString()).toBe("3");
      expect(pricing.commissionPerLot.toString()).toBe("7");
    });
  });

  it("uses the group's own override when a GroupSymbolConfig row exists for this symbol", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
      const broker = await tx.broker.create({ data: { name: `Pricing Test ${suffix}`, subdomain: `gptest2-${suffix}` } });
      const group = await tx.group.create({ data: { brokerId: broker.id, name: "Override Group", leverage: 100 } });
      const symbol = await tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
      await tx.groupSymbolConfig.create({
        data: { groupId: group.id, symbolId: symbol.id, spreadMarkup: D("0.5"), commissionPerLot: D("2") },
      });

      const pricing = await resolveSymbolPricing(tx, {
        groupId: group.id,
        symbolId: symbol.id,
        brokerSpreadMarkup: D("3"),
        brokerCommissionPerLot: D("7"),
      });
      expect(pricing.spreadMarkup.toString()).toBe("0.5");
      expect(pricing.commissionPerLot.toString()).toBe("2");
    });
  });
});

describe("chargeCommission (live DB, rolled back)", () => {
  async function makeAccount(tx: Prisma.TransactionClient, balance: string) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const broker = await tx.broker.create({ data: { name: `Commission Test ${suffix}`, subdomain: `commtest-${suffix}` } });
    return tx.account.create({
      data: {
        brokerId: broker.id,
        accountNumber: `8${suffix.slice(0, 7)}`,
        email: `comm-${suffix}@test.local`,
        passwordHash: "x",
        fullName: "Commission Test",
        accountMode: "LIVE",
        balance: D(balance),
      },
    });
  }

  it("debits balance and writes a COMMISSION transaction for a nonzero rate", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const account = await makeAccount(tx, "10000");
      await chargeCommission(tx, {
        brokerId: account.brokerId,
        accountId: account.id,
        positionId: "pos-1",
        commissionPerLot: D("7"),
        volume: D("2"),
      });

      const after = await tx.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(after.balance.toString()).toBe("9986"); // 10000 - 7*2

      const txn = await tx.transaction.findFirst({ where: { accountId: account.id, type: "COMMISSION" } });
      expect(txn).not.toBeNull();
      expect(txn!.amount.toString()).toBe("-14");
      expect(txn!.balanceBefore.toString()).toBe("10000");
      expect(txn!.balanceAfter.toString()).toBe("9986");
    });
  });

  it("writes no transaction at all for a zero commission rate (skip the no-op write)", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const account = await makeAccount(tx, "10000");
      await chargeCommission(tx, {
        brokerId: account.brokerId,
        accountId: account.id,
        positionId: "pos-1",
        commissionPerLot: D("0"),
        volume: D("2"),
      });

      const after = await tx.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(after.balance.toString()).toBe("10000");
      const txn = await tx.transaction.findFirst({ where: { accountId: account.id, type: "COMMISSION" } });
      expect(txn).toBeNull();
    });
  });
});
