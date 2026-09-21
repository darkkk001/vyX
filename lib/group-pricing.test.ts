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
  it("routes A_BOOK and COVERAGE to the A book, every other category to B", () => {
    expect(resolveBookType("A_BOOK")).toBe("A_BOOK");
    expect(resolveBookType("COVERAGE")).toBe("A_BOOK");
    expect(resolveBookType("B_BOOK")).toBe("B_BOOK");
    expect(resolveBookType("DEALING")).toBe("B_BOOK");
    expect(resolveBookType("REVERSAL")).toBe("B_BOOK");
  });

  // The 20260921100000_routing_category migration changed this function's
  // INPUT from GroupType to RoutingCategory. Every row it backfills has to
  // keep booking where it booked before, or Stage 1 silently re-routes live
  // risk. This is that equivalence, written out per legacy value.
  it("books every pre-migration groupType exactly where it booked before", () => {
    const legacyToCategory = {
      LP: "A_BOOK",
      COVERAGE: "COVERAGE",
      // DEALING backfills to B_BOOK (dealingMode AUTO), DEALING or
      // REVERSAL (mirror source) -- all three book B, as DEALING did.
      DEALING: ["B_BOOK", "DEALING", "REVERSAL"],
      // DEMO was never routing: it backfills to B_BOOK + DEMO_ONLY, and
      // B_BOOK books B exactly as DEMO did.
      DEMO: "B_BOOK",
    } as const;

    expect(resolveBookType(legacyToCategory.LP)).toBe("A_BOOK"); // was A_BOOK
    expect(resolveBookType(legacyToCategory.COVERAGE)).toBe("A_BOOK"); // was A_BOOK
    for (const c of legacyToCategory.DEALING) {
      expect(resolveBookType(c)).toBe("B_BOOK"); // was B_BOOK
    }
    expect(resolveBookType(legacyToCategory.DEMO)).toBe("B_BOOK"); // was B_BOOK
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
    const _g0 = await tx.group.create({ data: { brokerId: broker.id, name: `TG-${Math.random().toString(36).slice(2, 10)}`, dealingMode: "AUTO" } });
    return tx.account.create({
      data: { groupId: _g0.id,
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

  /** A real Position to charge against. Every caller of chargeCommission passes a position it
   *  has just created in the same transaction (manage/positions:368, trade/orders:614), so a
   *  fixture using a made-up id was testing a shape that never occurs. */
  async function makePosition(tx: Prisma.TransactionClient, account: { id: string; brokerId: string }) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const symbol = await tx.symbol.create({
      data: { name: `CT${suffix.slice(0, 6).toUpperCase()}`, baseCurrency: "USD", quoteCurrency: "USD", digits: 2, contractSize: D("100"), category: "METALS" },
    });
    const order = await tx.order.create({
      data: {
        brokerId: account.brokerId, accountId: account.id, symbolId: symbol.id,
        side: "BUY", type: "MARKET", status: "FILLED", volume: D("2"), requestedPrice: D("100"), idempotencyKey: `ct-${suffix}`,
      },
    });
    return tx.position.create({
      data: {
        brokerId: account.brokerId, accountId: account.id, symbolId: symbol.id,
        originOrderId: order.id, side: "BUY", volume: D("2"), openPrice: D("100"),
      },
    });
  }

  it("debits balance and writes a COMMISSION transaction for a nonzero rate", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const account = await makeAccount(tx, "10000");
      const position = await makePosition(tx, account);
      await chargeCommission(tx, {
        brokerId: account.brokerId,
        accountId: account.id,
        positionId: position.id,
        commissionPerLot: D("7"),
        volume: D("2"),
      });

      // The whole point of docs/WRONG-FIELD-AUDIT §2.1: the money left the balance and the
      // ledger recorded it, but Position.commission stayed 0, so IB payouts and every
      // commission report read zero on a position that HAD been charged.
      const charged = await tx.position.findUniqueOrThrow({ where: { id: position.id } });
      expect(charged.commission.toString()).toBe("14");

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
      const zeroPosition = await makePosition(tx, account);
      await chargeCommission(tx, {
        brokerId: account.brokerId,
        accountId: account.id,
        positionId: zeroPosition.id,
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
