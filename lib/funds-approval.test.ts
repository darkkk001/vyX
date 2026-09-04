import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  resolveFundsApprovalStep,
  markFundsRequestForApproval,
  cancelFundsRequestMark,
  rejectFundsRequest,
  approveFundsRequest,
} from "@/lib/funds-approval";

// Phase 1 §4 (docs/ROADMAP.md's "funds approval maker-checker") -- the
// maker-checker semantic itself (resolveFundsApprovalStep) is pure and
// exhaustively covered with no DB at all; the actual balance mutations
// are covered against a real DB below, same rolled-back-transaction
// pattern as lib/bulk-close.test.ts.

const D = (v: string | number) => new Prisma.Decimal(v);

describe("resolveFundsApprovalStep (maker-checker decision, pure)", () => {
  it("a DEPOSIT is always single-approval, regardless of any markedByAdminId", () => {
    expect(resolveFundsApprovalStep({ type: "DEPOSIT", markedByAdminId: null, actingAdminId: "admin-1" })).toEqual({ step: "approve" });
    // Even if some markedByAdminId were somehow set on a deposit, it's
    // still a plain approve -- the mark/confirm dance is withdrawal-only.
    expect(resolveFundsApprovalStep({ type: "DEPOSIT", markedByAdminId: "admin-2", actingAdminId: "admin-1" })).toEqual({ step: "approve" });
  });

  it("a WITHDRAWAL's first approval marks it -- no balance change yet", () => {
    expect(resolveFundsApprovalStep({ type: "WITHDRAWAL", markedByAdminId: null, actingAdminId: "admin-1" })).toEqual({ step: "mark" });
  });

  it("the SAME admin cannot confirm their own mark", () => {
    const result = resolveFundsApprovalStep({ type: "WITHDRAWAL", markedByAdminId: "admin-1", actingAdminId: "admin-1" });
    expect(result.step).toBe("error");
    if (result.step === "error") expect(result.error).toMatch(/different staff member/);
  });

  it("a DIFFERENT admin confirming an already-marked withdrawal actually approves it", () => {
    expect(resolveFundsApprovalStep({ type: "WITHDRAWAL", markedByAdminId: "admin-1", actingAdminId: "admin-2" })).toEqual({ step: "approve" });
  });
});

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/funds-approval.test.ts: DB unreachable, skipping DB-backed tests");
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
  const broker = await tx.broker.create({ data: { name: `Funds Approval Test ${suffix}`, subdomain: `fatest-${suffix}` } });
  const account = await tx.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `1${suffix.slice(0, 7)}`,
      email: `fa-client-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Funds Approval Test",
      accountMode: "LIVE",
      balance: D(balance),
    },
  });
  // markedByAdminId/reviewedByAdminId/actorAdminId are all real FKs to
  // AdminUser -- two distinct admins, since the whole point of the
  // maker-checker flow under test is that they must differ.
  const [admin1, admin2] = await Promise.all([
    tx.adminUser.create({ data: { brokerId: broker.id, email: `fa-admin1-${suffix}@test.local`, passwordHash: "x", role: "MANAGER" } }),
    tx.adminUser.create({ data: { brokerId: broker.id, email: `fa-admin2-${suffix}@test.local`, passwordHash: "x", role: "MANAGER" } }),
  ]);
  return { brokerId: broker.id, accountId: account.id, admin1Id: admin1.id, admin2Id: admin2.id };
}

async function createRequest(tx: Prisma.TransactionClient, fx: { brokerId: string; accountId: string }, type: "DEPOSIT" | "WITHDRAWAL", amount: string) {
  return tx.transaction.create({
    data: {
      brokerId: fx.brokerId,
      accountId: fx.accountId,
      type,
      status: "PENDING",
      amount: D(amount),
      balanceBefore: D("0"),
      balanceAfter: D("0"),
    },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("approveFundsRequest (live DB, rolled back)", () => {
  it("credits a deposit, moves it to COMPLETED, and writes a real audit row", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "1000");
      const req = await createRequest(tx, fx, "DEPOSIT", "500");

      const result = await approveFundsRequest(tx, {
        transactionId: req.id, brokerId: fx.brokerId, accountId: fx.accountId, amount: D("500"), adminId: fx.admin1Id, note: null, type: "DEPOSIT",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.balanceAfter.toString()).toBe("1500");

      const acct = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.balance.toString()).toBe("1500");
      const txn = await tx.transaction.findUniqueOrThrow({ where: { id: req.id } });
      expect(txn.status).toBe("COMPLETED");

      const audit = await tx.auditLog.findFirst({ where: { entityId: req.id, action: "FUNDS_REQUEST_APPROVED" } });
      expect(audit).not.toBeNull();
    });
  });

  it("rejects (409-shaped) a withdrawal that no longer fits the current balance, without mutating anything", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "100"); // balance dropped since the request was made
      const req = await createRequest(tx, fx, "WITHDRAWAL", "-500");

      const result = await approveFundsRequest(tx, {
        transactionId: req.id, brokerId: fx.brokerId, accountId: fx.accountId, amount: D("-500"), adminId: fx.admin2Id, note: null, type: "WITHDRAWAL",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/no longer sufficient/);

      const acct = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.balance.toString()).toBe("100"); // untouched
      const txn = await tx.transaction.findUniqueOrThrow({ where: { id: req.id } });
      expect(txn.status).toBe("PENDING"); // untouched
    });
  });

  it("full withdrawal maker-checker flow: mark, then a different admin approves and debits", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "1000");
      const req = await createRequest(tx, fx, "WITHDRAWAL", "-300");

      const step1 = resolveFundsApprovalStep({ type: "WITHDRAWAL", markedByAdminId: null, actingAdminId: fx.admin1Id });
      expect(step1.step).toBe("mark");
      const marked = await markFundsRequestForApproval(tx, { transactionId: req.id, brokerId: fx.brokerId, adminId: fx.admin1Id });
      expect(marked.markedByAdminId).toBe(fx.admin1Id);

      const acctAfterMark = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acctAfterMark.balance.toString()).toBe("1000"); // marking never touches balance

      const step2 = resolveFundsApprovalStep({ type: "WITHDRAWAL", markedByAdminId: fx.admin1Id, actingAdminId: fx.admin2Id });
      expect(step2.step).toBe("approve");
      const result = await approveFundsRequest(tx, {
        transactionId: req.id, brokerId: fx.brokerId, accountId: fx.accountId, amount: D("-300"), adminId: fx.admin2Id, note: null, type: "WITHDRAWAL",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.balanceAfter.toString()).toBe("700");
    });
  });
});

describe("rejectFundsRequest and cancelFundsRequestMark (live DB, rolled back)", () => {
  it("reject moves status to REJECTED and clears any mark, without touching balance", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "1000");
      const req = await createRequest(tx, fx, "WITHDRAWAL", "-300");
      await markFundsRequestForApproval(tx, { transactionId: req.id, brokerId: fx.brokerId, adminId: fx.admin1Id });

      const rejected = await rejectFundsRequest(tx, { transactionId: req.id, brokerId: fx.brokerId, adminId: fx.admin2Id, note: "insufficient documentation" });
      expect(rejected.status).toBe("REJECTED");

      const txn = await tx.transaction.findUniqueOrThrow({ where: { id: req.id } });
      expect(txn.markedByAdminId).toBeNull();
      expect(txn.note).toBe("insufficient documentation");
      const acct = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.balance.toString()).toBe("1000");
    });
  });

  it("cancelling a mark clears markedByAdminId and writes its own audit row", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, "1000");
      const req = await createRequest(tx, fx, "WITHDRAWAL", "-300");
      await markFundsRequestForApproval(tx, { transactionId: req.id, brokerId: fx.brokerId, adminId: fx.admin1Id });

      await cancelFundsRequestMark(tx, { transactionId: req.id, brokerId: fx.brokerId, previousMarkedByAdminId: fx.admin1Id, actorAdminId: fx.admin1Id });

      const txn = await tx.transaction.findUniqueOrThrow({ where: { id: req.id } });
      expect(txn.markedByAdminId).toBeNull();
      expect(txn.status).toBe("PENDING"); // cancelling a mark isn't a rejection
      const audit = await tx.auditLog.findFirst({ where: { entityId: req.id, action: "FUNDS_REQUEST_MARK_CANCELLED" } });
      expect(audit).not.toBeNull();
    });
  });
});
