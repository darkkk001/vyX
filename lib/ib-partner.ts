import "server-only";
import { Prisma } from "@prisma/client";
import { computePendingCommission, lockAccruedCommission } from "@/lib/commission";
import { executeIbPayout, IbPayoutRefusedError, ibPayoutRefusal } from "@/lib/ib-payout";

type Tx = Prisma.TransactionClient;

// Step 2 (owner 2026-09-30): IB "Suspend partner". A partner is its IB account (the account with ibLinkAsIb links);
// the flag lives on that account (Account.ibSuspendedAt), so every link, a new one included, reads the same state.
//   suspend      -> owed pay is locked in at this moment (kept, frozen, never zeroed); nothing new accrues; payouts refused
//   resume       -> payable again; the accrual clock restarts now (trades closed while suspended never count)
//   release-owed -> BROKER_ADMIN pays the frozen owed amount while still suspended, through the SAME payout function
//                   as any IB payout (lib/ib-payout.ts executeIbPayout), audited
// Every change runs in one transaction with its AuditLog row.

export class IbPartnerError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}

async function loadPartner(tx: Tx, brokerId: string, ibAccountId: string) {
  // row lock on the partner's account: suspend / resume / release of the same partner serialize
  await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${ibAccountId} FOR NO KEY UPDATE`;
  const account = await tx.account.findUnique({
    where: { id: ibAccountId },
    select: { id: true, brokerId: true, accountNumber: true, fullName: true, status: true, ibSuspendedAt: true, ibSuspendedById: true },
  });
  if (!account || account.brokerId !== brokerId) throw new IbPartnerError("partner not found", 404);
  const links = await tx.ibRelationship.findMany({ where: { ibAccountId, brokerId }, orderBy: { createdAt: "asc" } });
  if (links.length === 0) throw new IbPartnerError("this account is not a partner (no referred clients)", 404);
  return { account, links };
}

export async function suspendPartner(tx: Tx, p: { brokerId: string; ibAccountId: string; adminId: string; reason: string | null }) {
  const { account, links } = await loadPartner(tx, p.brokerId, p.ibAccountId);
  if (account.ibSuspendedAt) throw new IbPartnerError("partner is already suspended", 409);
  const at = new Date();
  let owed = new Prisma.Decimal(0);
  for (const link of links) owed = owed.add(await lockAccruedCommission(tx, { ...link, frozenAt: null }, at));
  await tx.account.update({ where: { id: account.id }, data: { ibSuspendedAt: at, ibSuspendedById: p.adminId } });
  await tx.auditLog.create({
    data: {
      brokerId: p.brokerId,
      actorAdminId: p.adminId,
      action: "IB_PARTNER_SUSPENDED",
      entityType: "Account",
      entityId: account.id,
      oldValue: { ibSuspendedAt: null },
      newValue: { ibSuspendedAt: at.toISOString(), frozenOwed: owed.toFixed(4), links: links.length, reason: p.reason },
    },
  });
  return { suspendedAt: at, frozenOwed: owed };
}

export async function resumePartner(tx: Tx, p: { brokerId: string; ibAccountId: string; adminId: string }) {
  const { account, links } = await loadPartner(tx, p.brokerId, p.ibAccountId);
  if (!account.ibSuspendedAt) throw new IbPartnerError("partner is not suspended", 409);
  const at = new Date();
  let owed = new Prisma.Decimal(0);
  for (const link of links) {
    owed = owed.add(await computePendingCommission(tx, { ...link, frozenAt: account.ibSuspendedAt }));
    // what was owed at suspension is already locked in accruedUnpaid (suspendPartner); accrual restarts now, so the
    // suspended window never counts
    await tx.ibRelationship.update({ where: { id: link.id }, data: { accruedThrough: at } });
  }
  await tx.account.update({ where: { id: account.id }, data: { ibSuspendedAt: null, ibSuspendedById: null } });
  await tx.auditLog.create({
    data: {
      brokerId: p.brokerId,
      actorAdminId: p.adminId,
      action: "IB_PARTNER_RESUMED",
      entityType: "Account",
      entityId: account.id,
      oldValue: { ibSuspendedAt: account.ibSuspendedAt.toISOString() },
      newValue: { ibSuspendedAt: null, resumedAt: at.toISOString(), owedPayableAgain: owed.toFixed(4), notCountedWindow: { from: account.ibSuspendedAt.toISOString(), to: at.toISOString() } },
    },
  });
  return { resumedAt: at, owed };
}

export async function releaseFrozenOwed(tx: Tx, p: { brokerId: string; ibAccountId: string; adminId: string; note: string | null }) {
  const { account, links } = await loadPartner(tx, p.brokerId, p.ibAccountId);
  if (!account.ibSuspendedAt) throw new IbPartnerError("partner is not suspended: pay it with Pay", 409);
  const refusal = await ibPayoutRefusal(tx, account.id, { allowSuspended: true });
  if (refusal) throw new IbPartnerError(refusal, 409);
  const paid: { relationshipId: string; transactionId: string; amount: string }[] = [];
  let total = new Prisma.Decimal(0);
  for (const link of links) {
    // the same payout function as every IB payout; it row-locks the link and recomputes what is owed after the lock
    const owed = await computePendingCommission(tx, { ...link, frozenAt: account.ibSuspendedAt });
    if (owed.lte(0)) continue;
    try {
      const r = await executeIbPayout(tx, { relationshipId: link.id, brokerId: p.brokerId, adminId: p.adminId, releaseOwed: true });
      paid.push({ relationshipId: link.id, transactionId: r.transaction.id, amount: r.transaction.amount.toString() });
      total = total.add(r.transaction.amount);
    } catch (e) {
      if (e instanceof IbPayoutRefusedError) throw new IbPartnerError(e.message, 409);
      if (e instanceof Error && e.message === "no pending commission to pay") continue; // raced: another release already paid it
      throw e;
    }
  }
  if (paid.length === 0) throw new IbPartnerError("no frozen partner pay is owed", 409);
  await tx.auditLog.create({
    data: {
      brokerId: p.brokerId,
      actorAdminId: p.adminId,
      action: "IB_PARTNER_OWED_RELEASED",
      entityType: "Account",
      entityId: account.id,
      newValue: { total: total.toFixed(4), payouts: paid, note: p.note, stillSuspended: true },
    },
  });
  return { total, paid };
}
