import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateBalanceAdjustment, applyBalanceAdjustment } from "@/lib/balance-adjustment";

// Phase 1 §4 (docs/ROADMAP.md's "balance adjustment").

const D = (v: string | number) => new Prisma.Decimal(v);

describe("validateBalanceAdjustment (pure)", () => {
  it("rejects a zero amount", () => {
    expect(validateBalanceAdjustment({ amount: D("0"), note: "correction" })).toMatch(/must not be zero/);
  });

  it("rejects a missing or whitespace-only note", () => {
    expect(validateBalanceAdjustment({ amount: D("100"), note: "" })).toMatch(/note is required/);
    expect(validateBalanceAdjustment({ amount: D("100"), note: "   " })).toMatch(/note is required/);
  });

  it("accepts a nonzero amount with a real note, positive or negative", () => {
    expect(validateBalanceAdjustment({ amount: D("100"), note: "bonus credit" })).toBeNull();
    expect(validateBalanceAdjustment({ amount: D("-50"), note: "chargeback correction" })).toBeNull();
  });
});

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/balance-adjustment.test.ts: DB unreachable, skipping");
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

async function createFixture(tx: Prisma.TransactionClient, balance = "1000") {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await tx.broker.create({ data: { name: `Balance Adj Test ${suffix}`, subdomain: `batest-${suffix}` } });
  const admin = await tx.adminUser.create({ data: { brokerId: broker.id, email: `ba-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const account = await tx.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `2${suffix.slice(0, 7)}`,
      email: `ba-client-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Balance Adj Test",
      accountType: "LIVE",
      balance: D(balance),
    },
  });
  return { brokerId: broker.id, accountId: account.id, adminId: admin.id };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("applyBalanceAdjustment (live DB, rolled back)", () => {
  it("a positive adjustment credits the account and writes a real ledger + audit row", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "1000");
      const result = await applyBalanceAdjustment(tx, { accountId: fx.accountId, brokerId: fx.brokerId, amount: D("250"), note: "goodwill credit", adminId: fx.adminId });

      expect(result.balanceAfter.toString()).toBe("1250");
      const acct = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.balance.toString()).toBe("1250");

      const txn = await tx.transaction.findUniqueOrThrow({ where: { id: result.transactionId } });
      expect(txn.type).toBe("ADJUSTMENT");
      expect(txn.amount.toString()).toBe("250");
      expect(txn.balanceBefore.toString()).toBe("1000");
      expect(txn.note).toBe("goodwill credit");

      const audit = await tx.auditLog.findFirst({ where: { entityId: fx.accountId, action: "BALANCE_ADJUSTMENT" } });
      expect(audit).not.toBeNull();
      expect((audit!.newValue as { amount: string }).amount).toBe("250");
    });
  });

  it("a negative adjustment debits the account correctly", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "1000");
      const result = await applyBalanceAdjustment(tx, { accountId: fx.accountId, brokerId: fx.brokerId, amount: D("-300"), note: "chargeback", adminId: fx.adminId });

      expect(result.balanceAfter.toString()).toBe("700");
      const acct = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.balance.toString()).toBe("700");
    });
  });

  it("reads the account's fresh balance at apply time, not a stale caller-supplied one", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "1000");
      // Simulate balance having moved (a trade settled) between whenever
      // a caller might have last read it and this call.
      await tx.account.update({ where: { id: fx.accountId }, data: { balance: D("5000") } });

      const result = await applyBalanceAdjustment(tx, { accountId: fx.accountId, brokerId: fx.brokerId, amount: D("100"), note: "correction", adminId: fx.adminId });
      expect(result.balanceAfter.toString()).toBe("5100"); // based on the fresh 5000, not the original 1000
    });
  });
});
