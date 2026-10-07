import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// Step 3b item 2b (owner 2026-10-07): Broker.auditRetentionDays. A broker with a value has its AuditLog rows older than
// that many days deleted by the daily cron (app/api/internal/audit-retention); null keeps everything. The minimum is
// 365 days (lib/broker-settings.ts), re-checked here so a bad row in the database can never purge recent history.
// Each purge writes one AUDIT_LOG_PURGED row (it is newer than the cutoff, so it survives its own purge).
export const AUDIT_PURGE_BATCH = 5000;
export const AUDIT_PURGE_MAX_BATCHES = 40;
const MIN_DAYS = 365;

export type PurgeResult = { brokerId: string; days: number; deleted: number }[];

export async function purgeExpiredAuditLogs(db: PrismaClient, now: Date = new Date()): Promise<PurgeResult> {
  const brokers = await db.broker.findMany({ where: { auditRetentionDays: { not: null } }, select: { id: true, auditRetentionDays: true } });
  const out: PurgeResult = [];
  for (const b of brokers) {
    const days = b.auditRetentionDays!;
    if (!Number.isInteger(days) || days < MIN_DAYS) continue;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    let deleted = 0;
    for (let i = 0; i < AUDIT_PURGE_MAX_BATCHES; i++) {
      const n = await db.$executeRaw`DELETE FROM "AuditLog" WHERE "id" IN (SELECT "id" FROM "AuditLog" WHERE "brokerId" = ${b.id} AND "createdAt" < ${cutoff} LIMIT ${AUDIT_PURGE_BATCH})`;
      deleted += n;
      if (n < AUDIT_PURGE_BATCH) break;
    }
    if (deleted > 0) {
      await db.auditLog.create({
        data: { brokerId: b.id, action: "AUDIT_LOG_PURGED", entityType: "Broker", entityId: b.id, newValue: { retentionDays: days, deleted, olderThan: cutoff.toISOString() } },
      });
    }
    out.push({ brokerId: b.id, days, deleted });
  }
  return out;
}
