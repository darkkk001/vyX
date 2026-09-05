import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// In-app only -- no email/SMS infra exists anywhere in this app.
// Broker-scoped, shared read state (see Notification's own schema
// comment). Called from the four points that create the underlying
// thing being notified about, not exposed as its own POST endpoint.
export async function createNotification(
  db: Db,
  params: { brokerId: string; type: string; title: string; body: string; entityType?: string; entityId?: string; accountId?: string }
): Promise<void> {
  await db.notification.create({
    data: {
      brokerId: params.brokerId,
      type: params.type,
      title: params.title,
      body: params.body,
      entityType: params.entityType,
      entityId: params.entityId,
      // Optional, backward-compatible (2026-09-05) -- set for a trader-
      // scoped notification (e.g. "MARGIN_CALL"), left undefined/null for
      // every existing broker-staff-facing type, unchanged.
      accountId: params.accountId,
    },
  });
}
