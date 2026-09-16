import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { provisionAccount } from "@/lib/account-provisioning";

// Dealer coverage (B-book hedging). A broker hedges a client's B-book
// position by clicking BOOK NOW (app/api/manage/positions/[id]/book),
// which mirrors the SAME-side leg onto one system account so the broker's
// book nets flat: client BUY 1 lot => broker is effectively short 1 lot;
// a coverage BUY 1 lot cancels that, so a price move that owes the client
// is exactly offset by the coverage account's gain (see the book route's
// own comment for the P&L walk-through).
//
// The coverage account lives in a groupType=COVERAGE system group. Raw
// pricing (no spread markup, no commission) isn't enforced by the group
// config -- the book route creates the hedge leg directly at the live
// market price with zero commission, deliberately bypassing
// resolveSymbolPricing/chargeCommission so the hedge reflects the real
// market rather than re-charging the broker its own markup.

// Stable per-broker name for the coverage group (Group is unique on
// [brokerId, name]) -- lets ensureCoverageGroup be idempotent.
export const COVERAGE_GROUP_NAME = "Dealer Coverage (system)";

async function ensureCoverageGroup(brokerId: string): Promise<{ id: string; leverage: number }> {
  const existing = await prisma.group.findFirst({
    where: { brokerId, groupType: "COVERAGE" },
    select: { id: true, leverage: true },
  });
  if (existing) return existing;
  try {
    const created = await prisma.group.create({
      data: {
        brokerId,
        name: COVERAGE_GROUP_NAME,
        groupType: "COVERAGE",
        // High leverage: the coverage account is the broker's own hedge
        // book, never margin-called the way a client is -- a low cap would
        // only risk a spurious stop-out on the broker's own hedge.
        leverage: 500,
        isDefault: false,
      },
      select: { id: true, leverage: true },
    });
    return created;
  } catch {
    // Lost a create race on the unique [brokerId, name] -- re-read the
    // winner.
    const found = await prisma.group.findFirst({
      where: { brokerId, groupType: "COVERAGE" },
      select: { id: true, leverage: true },
    });
    if (found) return found;
    throw new Error("failed to provision coverage group");
  }
}

export type CoverageAccount = { accountId: string; groupId: string };

// Returns the broker's coverage account, provisioning the COVERAGE group
// and a fresh system Account on first use and stamping
// Broker.coverageAccountId. Idempotent and safe to call on every BOOK NOW
// (the common case is a single findUnique that returns the existing id).
export async function ensureCoverageAccount(
  brokerId: string,
  createdByAdminId: string | null
): Promise<CoverageAccount> {
  const broker = await prisma.broker.findUniqueOrThrow({
    where: { id: brokerId },
    select: { coverageAccountId: true },
  });
  if (broker.coverageAccountId) {
    const acct = await prisma.account.findUnique({
      where: { id: broker.coverageAccountId },
      select: { id: true, groupId: true },
    });
    // Pointer set and the account still exists -- the steady state.
    if (acct) return { accountId: acct.id, groupId: acct.groupId ?? (await ensureCoverageGroup(brokerId)).id };
    // Dangling pointer (account deleted) -- fall through and re-provision.
  }

  const group = await ensureCoverageGroup(brokerId);

  // A real, functional LIVE account, but system-owned: a random
  // credential nobody logs in with (the account is only ever written by
  // the book route, never by a trader). email carries the broker id to
  // stay unique across brokers on the same platform.
  const passwordHash = await bcrypt.hash(randomBytes(24).toString("hex"), 10);
  const account = await provisionAccount({
    brokerId,
    fullName: "Dealer Coverage",
    email: `coverage.${brokerId}@system.vyxtrader.internal`,
    passwordHash,
    accountMode: "LIVE",
    accountTypeId: null,
    currency: "USD",
    leverage: group.leverage,
    groupId: group.id,
    initialBalance: new Prisma.Decimal(0),
    country: null,
    phone: null,
    dateOfBirth: null,
    clientId: null,
    createdByAdminId,
  });

  // Claim the pointer only if still unset -- a concurrent BOOK NOW may
  // have provisioned and claimed first. updateMany (not update) so the
  // where-guard makes this a no-op instead of an error when we lose.
  const claim = await prisma.broker.updateMany({
    where: { id: brokerId, coverageAccountId: null },
    data: { coverageAccountId: account.id },
  });
  if (claim.count === 0) {
    // A racing caller won the pointer. Ours is a harmless inert extra
    // account (0 balance, no positions, no login) -- use the winner.
    const winner = await prisma.broker.findUniqueOrThrow({
      where: { id: brokerId },
      select: { coverageAccountId: true },
    });
    if (winner.coverageAccountId && winner.coverageAccountId !== account.id) {
      const acct = await prisma.account.findUnique({
        where: { id: winner.coverageAccountId },
        select: { id: true, groupId: true },
      });
      if (acct) return { accountId: acct.id, groupId: acct.groupId ?? group.id };
    }
  }

  await prisma.auditLog.create({
    data: {
      brokerId,
      actorAdminId: createdByAdminId,
      action: "COVERAGE_ACCOUNT_PROVISIONED",
      entityType: "Account",
      entityId: account.id,
      newValue: { accountNumber: account.accountNumber, groupId: group.id },
    },
  });

  return { accountId: account.id, groupId: group.id };
}
