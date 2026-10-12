import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { revokeAllAccountSessions } from "@/lib/account-auth";
import { clearDemoState, getDemoBrokerId, GUEST_IDLE_DAYS, GUEST_MAX_AGE_DAYS, isGuestAccountNumber } from "@/lib/demo";
import { demoSubdomain } from "@/lib/demo-policy";
import { sweepAllGuests } from "@/lib/demo-sweep";

// Daily clean-up of the QoreTrader demo's throwaway guests (cron /api/internal/demo-cleanup, vercel.json).
//
// A guest is deleted when it has had no login (LoginEvent) and no order for GUEST_IDLE_DAYS (7) days, or is older than
// GUEST_MAX_AGE_DAYS (30). The delete is the ONLY place in the platform that deletes executed trades and ledger rows (the
// "never delete executed trades" rule is for customers: a guest is a disposable demo account), so it is fenced three ways, all
// inside the delete function itself and not only in the query that picks candidates:
//   1. the demo tenant must be configured (DEMO_BROKER_SUBDOMAIN) and its broker must exist;
//   2. the account must belong to THAT broker;
//   3. its number must be inside the reserved guest range 48000000-48999999.
// Anything else is refused and nothing is touched. Every delete is scoped by the account's own id (and, for the audit trail,
// by the demo broker id as well); there is no delete that is selected by broker alone.

export type DeleteResult = { deleted: boolean; refused?: string; counts: Record<string, number> };

const CHUNK = 5000;
function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Which guests are due: no login and no order for 7 days (and older than 7 days), or older than 30 days. */
export async function findCleanupCandidates(db: Pick<PrismaClient, "$queryRaw">, brokerId: string, limit = 200): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT a.id FROM "Account" a
    WHERE a."brokerId" = ${brokerId}
      AND a."accountNumber" ~ '^48[0-9]{6}$'
      AND (
        a."createdAt" < now() - make_interval(days => ${GUEST_MAX_AGE_DAYS})
        OR (
          a."createdAt" < now() - make_interval(days => ${GUEST_IDLE_DAYS})
          AND NOT EXISTS (SELECT 1 FROM "LoginEvent" l WHERE l."accountId" = a.id AND l."createdAt" >= now() - make_interval(days => ${GUEST_IDLE_DAYS}))
          AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."accountId" = a.id AND o."createdAt" >= now() - make_interval(days => ${GUEST_IDLE_DAYS}))
        )
      )
    ORDER BY a."createdAt" ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/**
 * Delete ONE guest account and everything of it. Refuses (and changes nothing) unless the account is a guest of the demo
 * broker: see the header. `dryRun` counts what would go and writes nothing.
 */
export async function deleteGuestAccount(accountId: string, opts: { dryRun?: boolean } = {}, db: PrismaClient = prisma): Promise<DeleteResult> {
  const refuse = (why: string): DeleteResult => ({ deleted: false, refused: why, counts: {} });
  if (!demoSubdomain()) return refuse("DEMO_BROKER_SUBDOMAIN is not set");
  const demoBrokerId = await getDemoBrokerId(db);
  if (!demoBrokerId) return refuse("the demo broker was not found");
  const account = await db.account.findUnique({ where: { id: accountId }, select: { id: true, brokerId: true, accountNumber: true } });
  if (!account) return refuse("no such account");
  if (account.brokerId !== demoBrokerId) return refuse("the account does not belong to the demo broker");
  if (!isGuestAccountNumber(account.accountNumber)) return refuse("the account number is outside the guest range 48000000-48999999");

  const positions = await db.position.findMany({ where: { accountId }, select: { id: true } });
  const orders = await db.order.findMany({ where: { accountId }, select: { id: true } });
  const positionIds = positions.map((p) => p.id);
  const orderIds = orders.map((o) => o.id);

  const counts: Record<string, number> = {
    positions: positionIds.length,
    orders: orderIds.length,
    transactions: await db.transaction.count({ where: { accountId } }),
    loginEvents: await db.loginEvent.count({ where: { accountId } }),
    notifications: await db.notification.count({ where: { accountId } }),
    watchlistItems: await db.watchlistItem.count({ where: { accountId } }),
    priceAlerts: await db.priceAlert.count({ where: { accountId } }),
    auditLogs: 0,
  };
  const auditWhere: Prisma.AuditLogWhereInput = {
    brokerId: demoBrokerId,
    OR: [{ entityId: accountId }, ...chunks(positionIds).map((c) => ({ entityType: "Position", entityId: { in: c } })), ...chunks(orderIds).map((c) => ({ entityType: "Order", entityId: { in: c } }))],
  };
  counts.auditLogs = await db.auditLog.count({ where: auditWhere });
  if (opts.dryRun) return { deleted: false, counts };

  await db.$transaction(
    async (tx) => {
      // re-check inside the transaction: the facts above must still hold at the moment of the delete
      const again = await tx.account.findUnique({ where: { id: accountId }, select: { brokerId: true, accountNumber: true } });
      if (!again || again.brokerId !== demoBrokerId || !isGuestAccountNumber(again.accountNumber)) throw new Error("guard failed inside the transaction");

      // links between rows first
      await tx.position.updateMany({ where: { accountId }, data: { coveragePositionId: null, closePendingOrderId: null } });
      await tx.order.updateMany({ where: { accountId }, data: { closesPositionId: null } });
      for (const c of chunks(positionIds)) {
        await tx.positionActionRequest.deleteMany({ where: { positionId: { in: c } } });
        await tx.mirrorLink.deleteMany({ where: { OR: [{ sourcePositionId: { in: c } }, { targetPositionId: { in: c } }] } });
      }
      await tx.postCloseEffect.deleteMany({ where: { accountId, brokerId: demoBrokerId } });
      // the ledger and the book
      await tx.transaction.deleteMany({ where: { accountId } });
      await tx.position.deleteMany({ where: { accountId } });
      await tx.order.deleteMany({ where: { accountId } });
      // everything else that points at the account
      await tx.watchlistItem.deleteMany({ where: { accountId } });
      await tx.priceAlert.deleteMany({ where: { accountId } });
      await tx.kycRecord.deleteMany({ where: { accountId } });
      await tx.savedWithdrawalAddress.deleteMany({ where: { accountId } });
      await tx.notification.deleteMany({ where: { accountId } });
      await tx.loginEvent.deleteMany({ where: { accountId } });
      await tx.balanceAdjustmentRequest.deleteMany({ where: { OR: [{ accountId }, { toAccountId: accountId }] } });
      await tx.mirrorRule.deleteMany({ where: { targetAccountId: accountId } });
      await tx.ibRelationship.deleteMany({ where: { OR: [{ ibAccountId: accountId }, { clientAccountId: accountId }] } });
      await tx.liveAccountRequest.updateMany({ where: { createdAccountId: accountId }, data: { createdAccountId: null } });
      await tx.lead.updateMany({ where: { convertedAccountId: accountId }, data: { convertedAccountId: null } });
      await tx.riskAccountMark.deleteMany({ where: { accountId } });
      await tx.accountSymbolConfig.deleteMany({ where: { accountId } });
      // the audit trail of this account (scoped to the demo broker as well)
      await tx.auditLog.deleteMany({ where: auditWhere });
      await tx.account.delete({ where: { id: accountId } });
    },
    { timeout: 60_000, maxWait: 10_000 }
  );

  // sessions and the replay cursor live in Redis
  await revokeAllAccountSessions(accountId).catch((err) => console.error("demo-cleanup: revoke sessions failed", accountId, err));
  await clearDemoState(accountId).catch(() => {});
  return { deleted: true, counts };
}

export type CleanupSummary = {
  dryRun: boolean;
  swept: { accounts: number; events: number; incomplete: number } | null;
  candidates: number;
  deleted: number;
  refused: { accountId: string; why: string }[];
  failed: number;
};

/** The daily job: replay the guests that still hold something, then delete the idle and the old ones. */
export async function runDemoCleanup(opts: { dryRun?: boolean; limit?: number; deadlineAtMs?: number } = {}): Promise<CleanupSummary> {
  const dryRun = opts.dryRun === true;
  const limit = opts.limit ?? 200;
  const deadline = opts.deadlineAtMs ?? Date.now() + 45_000;
  const summary: CleanupSummary = { dryRun, swept: null, candidates: 0, deleted: 0, refused: [], failed: 0 };
  const brokerId = demoSubdomain() ? await getDemoBrokerId() : null;
  if (!brokerId) return summary; // no demo tenant here: nothing to do

  if (!dryRun) summary.swept = await sweepAllGuests(Date.now(), 500);
  const ids = await findCleanupCandidates(prisma, brokerId, limit);
  summary.candidates = ids.length;
  for (const id of ids) {
    if (Date.now() > deadline) break; // the rest goes tomorrow
    try {
      const r = await deleteGuestAccount(id, { dryRun });
      if (r.deleted) summary.deleted++;
      else if (r.refused) summary.refused.push({ accountId: id, why: r.refused });
    } catch (err) {
      summary.failed++;
      console.error("demo-cleanup: delete failed", id, err);
    }
  }
  return summary;
}
