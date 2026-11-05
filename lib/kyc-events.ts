import "server-only";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { publishRoomChanged } from "@/lib/room/events";
import { sendKycDecisionEmail } from "@/lib/email/client-notices";
import type { KycDecisionAction } from "@/lib/kyc-decision";

// The client hears a KYC decision: a notification row, the room event so an open bell picks it up, and an e-mail. Runs
// after the decision committed and never fails the caller. Notify only: no KYC state is read or changed here.
// A client-level decision goes on the client's primary account (LIVE first, then oldest); a client with no account yet
// gets a row on the client itself.
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
    const approved = args.action === "APPROVE";
    const title = approved ? "Your KYC was approved" : "Your KYC was rejected";
    await createNotification(prisma, {
      brokerId: args.brokerId,
      accountId,
      clientId: accountId ? undefined : args.clientId,
      type: approved ? "KYC_APPROVED" : "KYC_REJECTED",
      title,
      body: !approved && args.rejectionReason ? `${title}: ${args.rejectionReason}` : title,
      entityType: args.entityType,
      entityId: args.entityId,
    });
    if (accountId) await publishRoomChanged(args.brokerId, [accountId], "kyc");
    const to = args.clientId
      ? (await prisma.client.findUnique({ where: { id: args.clientId }, select: { email: true } }))?.email
      : accountId
        ? (await prisma.account.findUnique({ where: { id: accountId }, select: { email: true, client: { select: { email: true } } } }).then((a) => a?.client?.email ?? a?.email))
        : null;
    if (to) await sendKycDecisionEmail({ brokerId: args.brokerId, to, approved, rejectionReason: args.rejectionReason });
  } catch (err) {
    console.error("[kyc-events] client notification failed", err);
  }
}
