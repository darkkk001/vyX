import "server-only";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { publishRoomChanged } from "@/lib/room/events";
import type { KycDecisionAction } from "@/lib/kyc-decision";

// The client hears a KYC decision: a notification row on their account, then the room event so an open bell picks it
// up. Runs after the decision committed and never fails the caller. Notify only: no KYC state is read or changed here.
// A client-level decision goes on the client's primary account (LIVE first, then oldest): the inbox is per account, so
// a client with no account yet gets no row and sees the decision on the dashboard's verification card instead.
export async function notifyKycDecision(args: {
  brokerId: string;
  accountId?: string;
  clientId?: string;
  entityType: "KycRecord" | "ClientKycRecord";
  entityId: string;
  action: KycDecisionAction;
  rejectionReason: string;
}): Promise<void> {
  try {
    const accountId = args.accountId ?? (args.clientId
      ? (await prisma.account.findFirst({
          where: { clientId: args.clientId, brokerId: args.brokerId, status: { not: "CLOSED" } },
          orderBy: [{ accountMode: "desc" }, { createdAt: "asc" }],
          select: { id: true },
        }))?.id
      : undefined);
    if (!accountId) return;
    const approved = args.action === "APPROVE";
    const title = approved ? "Your KYC was approved" : "Your KYC was rejected";
    await createNotification(prisma, {
      brokerId: args.brokerId,
      accountId,
      type: approved ? "KYC_APPROVED" : "KYC_REJECTED",
      title,
      body: !approved && args.rejectionReason ? `${title}: ${args.rejectionReason}` : title,
      entityType: args.entityType,
      entityId: args.entityId,
    });
    await publishRoomChanged(args.brokerId, [accountId], "kyc");
  } catch (err) {
    console.error("[kyc-events] client notification failed", err);
  }
}
