import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { swapMultiplier, computeSwapAmount, resolveSwapRate, runSwapRollover } from "@/lib/swap-rollover";

const D = (v: string | number) => new Prisma.Decimal(v);

describe("swapMultiplier", () => {
  it("mirrors engine/order-management/src/swap.rs's swap_multiplier: 3x on Wednesday, 1x every other day", () => {
    expect(swapMultiplier(3).toString()).toBe("3");
    for (const day of [1, 2, 4, 5, 6, 7]) expect(swapMultiplier(day).toString()).toBe("1");
  });

  it("falls back to 1x for an out-of-range weekday value, same as the Rust version", () => {
    expect(swapMultiplier(0).toString()).toBe("1");
    expect(swapMultiplier(99).toString()).toBe("1");
  });
});

describe("computeSwapAmount", () => {
  it("scales by rate, volume, and multiplier, same as swap.rs's compute_swap", () => {
    expect(computeSwapAmount(D("-6.50"), D("2"), D("1")).toString()).toBe("-13");
    expect(computeSwapAmount(D("-6.50"), D("2"), D("3")).toString()).toBe("-39");
  });

  it("can be a credit -- sign comes straight from rate, never forced negative", () => {
    expect(computeSwapAmount(D("2.00"), D("1"), D("1")).toString()).toBe("2");
  });
});

describe("resolveSwapRate", () => {
  it("falls back to the broker-wide rate when there is no group override", () => {
    const rate = resolveSwapRate({ side: "BUY", groupOverride: null, brokerSwapLong: D("-6.5"), brokerSwapShort: D("0.35") });
    expect(rate.toString()).toBe("-6.5");
  });

  it("uses the group override's matching side when one exists, same resolution order as resolveSymbolPricing", () => {
    const rate = resolveSwapRate({
      side: "SELL",
      groupOverride: { swapLong: D("-1"), swapShort: D("5") },
      brokerSwapLong: D("-6.5"),
      brokerSwapShort: D("0.35"),
    });
    expect(rate.toString()).toBe("5");
  });
});

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/swap-rollover.test.ts: DB unreachable, skipping DB-backed tests");
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

afterAll(async () => {
  await prisma.$disconnect();
});

type Fixture = { brokerId: string; accountId: string; groupId: string | null; symbolId: string };

async function createFixture(
  tx: Prisma.TransactionClient,
  params: { swapLong: string; swapShort: string; withGroup?: boolean; groupSwapLong?: string; groupSwapShort?: string }
): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await tx.broker.create({ data: { name: `Swap Rollover Test ${suffix}`, subdomain: `swaptest-${suffix}` } });
  const symbol = await tx.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
  await tx.brokerSymbol.create({
    data: {
      brokerId: broker.id,
      symbolId: symbol.id,
      minLot: D("0.01"),
      maxLot: D("1000"),
      lotStep: D("0.01"),
      swapLong: D(params.swapLong),
      swapShort: D(params.swapShort),
    },
  });

  let groupId: string | null = null;
  if (params.withGroup) {
    const group = await tx.group.create({ data: { brokerId: broker.id, name: "Swap Test Group", leverage: 100 } });
    groupId = group.id;
    if (params.groupSwapLong !== undefined) {
      await tx.groupSymbolConfig.create({
        data: { groupId, symbolId: symbol.id, swapLong: D(params.groupSwapLong), swapShort: D(params.groupSwapShort ?? "0") },
      });
    }
  }

  const account = await tx.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `7${suffix.slice(0, 7)}`,
      email: `swap-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Swap Rollover Test Client",
      accountType: "LIVE",
      balance: D("10000"),
      groupId,
    },
  });

  return { brokerId: broker.id, accountId: account.id, groupId, symbolId: symbol.id };
}

// Every test below passes accountIdsOverride, so in practice
// summary.brokers never holds more than this fixture's own one entry --
// looked up by brokerId anyway rather than assumed to be index 0, since
// nothing about the return shape actually promises an order.
function brokerSummary(summary: Awaited<ReturnType<typeof runSwapRollover>>, brokerId: string) {
  return summary.brokers.find((b) => b.brokerId === brokerId);
}

async function createOpenPosition(tx: Prisma.TransactionClient, fx: Fixture, params: { side: "BUY" | "SELL"; volume?: string }) {
  const order = await tx.order.create({
    data: {
      brokerId: fx.brokerId,
      accountId: fx.accountId,
      symbolId: fx.symbolId,
      side: params.side,
      type: "MARKET",
      volume: D(params.volume ?? "1"),
      status: "FILLED",
      filledPrice: D("4000.00"),
      filledAt: new Date(),
      idempotencyKey: `swap-test:${randomUUID()}`,
    },
  });
  return tx.position.create({
    data: {
      brokerId: fx.brokerId,
      accountId: fx.accountId,
      symbolId: fx.symbolId,
      originOrderId: order.id,
      side: params.side,
      volume: D(params.volume ?? "1"),
      openPrice: D("4000.00"),
      status: "OPEN",
    },
  });
}

describe("runSwapRollover (live DB, rolled back)", () => {
  it("normal day: charges rate * volume * 1x, updates the position's running total, balance, a SWAP transaction, and an audit row", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, { swapLong: "-6.50", swapShort: "0.35" });
      const position = await createOpenPosition(tx, fx, { side: "BUY", volume: "2" });

      const summary = await runSwapRollover(tx, { isoWeekdayOverride: 1, accountIdsOverride: [fx.accountId] }); // Monday

      expect(summary.multiplier).toBe("1");
      const mine = brokerSummary(summary, fx.brokerId);
      expect(mine).toBeDefined();
      expect(mine!.positionsCharged).toBe(1);
      expect(mine!.totalAmount).toBe("-13"); // -6.50 * 2 * 1

      const after = await tx.position.findUniqueOrThrow({ where: { id: position.id } });
      expect(after.swap.toString()).toBe("-13");
      expect(after.lastSwapAt).not.toBeNull();

      const account = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(account.balance.toString()).toBe("9987"); // 10000 - 13

      const txn = await tx.transaction.findFirst({ where: { accountId: fx.accountId, type: "SWAP" } });
      expect(txn).not.toBeNull();
      expect(txn!.amount.toString()).toBe("-13");
      expect(txn!.balanceBefore.toString()).toBe("10000");
      expect(txn!.balanceAfter.toString()).toBe("9987");

      const audit = await tx.auditLog.findFirst({ where: { brokerId: fx.brokerId, action: "SWAP_ROLLOVER_RUN" } });
      expect(audit).not.toBeNull();
      expect((audit!.newValue as Record<string, unknown>).positionsCharged).toBe(1);
      expect((audit!.newValue as Record<string, unknown>).totalAmount).toBe("-13");
    });
  });

  it("Wednesday triples the charge (rolls the weekend into one charge)", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, { swapLong: "-6.50", swapShort: "0.35" });
      const position = await createOpenPosition(tx, fx, { side: "BUY", volume: "2" });

      const summary = await runSwapRollover(tx, { isoWeekdayOverride: 3, accountIdsOverride: [fx.accountId] }); // Wednesday

      expect(summary.multiplier).toBe("3");
      expect(brokerSummary(summary, fx.brokerId)!.totalAmount).toBe("-39"); // -6.50 * 2 * 3

      const after = await tx.position.findUniqueOrThrow({ where: { id: position.id } });
      expect(after.swap.toString()).toBe("-39");

      const account = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(account.balance.toString()).toBe("9961"); // 10000 - 39
    });
  });

  it("idempotency: running twice for the same day charges once, not twice", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, { swapLong: "-6.50", swapShort: "0.35" });
      const position = await createOpenPosition(tx, fx, { side: "BUY", volume: "2" });

      const first = await runSwapRollover(tx, { isoWeekdayOverride: 1, accountIdsOverride: [fx.accountId] });
      expect(brokerSummary(first, fx.brokerId)!.totalAmount).toBe("-13");

      const second = await runSwapRollover(tx, { isoWeekdayOverride: 1, accountIdsOverride: [fx.accountId] });
      // This fixture's position was already claimed for today by the
      // first run above -- nothing due within the scoped account, so the
      // second pass finds no broker entry for it at all.
      expect(second.brokers).toHaveLength(0);

      const after = await tx.position.findUniqueOrThrow({ where: { id: position.id } });
      expect(after.swap.toString()).toBe("-13"); // unchanged by the second run

      const account = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(account.balance.toString()).toBe("9987"); // unchanged by the second run

      const txnCount = await tx.transaction.count({ where: { accountId: fx.accountId, type: "SWAP" } });
      expect(txnCount).toBe(1); // still just the one, not two
    });
  });

  it("zero-swap symbol: claims the position (so it isn't retried) but writes no transaction and moves no balance", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, { swapLong: "0", swapShort: "0" }); // defaults, no rate configured
      const position = await createOpenPosition(tx, fx, { side: "BUY", volume: "5" });

      const summary = await runSwapRollover(tx, { isoWeekdayOverride: 1, accountIdsOverride: [fx.accountId] });

      const mine = brokerSummary(summary, fx.brokerId);
      expect(mine).toBeDefined();
      expect(mine!.positionsClaimed).toBe(1);
      expect(mine!.positionsCharged).toBe(0);
      expect(mine!.totalAmount).toBe("0");

      const after = await tx.position.findUniqueOrThrow({ where: { id: position.id } });
      expect(after.swap.toString()).toBe("0");
      expect(after.lastSwapAt).not.toBeNull(); // claimed even though nothing was charged

      const account = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(account.balance.toString()).toBe("10000"); // unchanged

      const txn = await tx.transaction.findFirst({ where: { accountId: fx.accountId, type: "SWAP" } });
      expect(txn).toBeNull(); // no-op write, same convention as chargeCommission

      // The audit row still gets written -- it confirms the job ran and
      // touched this position, distinct from "this broker's job never ran."
      const audit = await tx.auditLog.findFirst({ where: { brokerId: fx.brokerId, action: "SWAP_ROLLOVER_RUN" } });
      expect(audit).not.toBeNull();
      expect((audit!.newValue as Record<string, unknown>).positionsCharged).toBe(0);
    });
  });

  it("a group-level swap override wins over the broker-wide rate", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, {
        swapLong: "-6.50",
        swapShort: "0.35",
        withGroup: true,
        groupSwapLong: "-1.00",
        groupSwapShort: "2.00",
      });
      const position = await createOpenPosition(tx, fx, { side: "BUY", volume: "3" });

      const summary = await runSwapRollover(tx, { isoWeekdayOverride: 1, accountIdsOverride: [fx.accountId] });

      expect(brokerSummary(summary, fx.brokerId)!.totalAmount).toBe("-3"); // group override -1.00 * 3 * 1, not the broker's -6.50

      const after = await tx.position.findUniqueOrThrow({ where: { id: position.id } });
      expect(after.swap.toString()).toBe("-3");
    });
  });
});
