import "server-only";
import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// Extracted out of app/api/manage/kyc-requests/[id]/route.ts (Phase 1
// §4, docs/ROADMAP.md's "KYC decision") for direct testability -- same
// "pure validation, DB mutation at the call site" split as every other
// extracted lib in this app.

export type KycDecisionAction = "APPROVE" | "REJECT";

// Pure -- REJECT requires a reason (an unexplained KYC rejection gives
// the trader nothing actionable and leaves no record of why for a
// dispute); APPROVE never needs one.
export function validateKycDecision(params: { action: KycDecisionAction; rejectionReason: string }): string | null {
  if (params.action === "REJECT" && !params.rejectionReason.trim()) {
    return "rejectionReason is required to reject";
  }
  return null;
}

export async function applyKycDecision(
  tx: Tx,
  params: { kycRecordId: string; brokerId: string; action: KycDecisionAction; rejectionReason: string; adminId: string }
): Promise<{ id: string; status: string }> {
  const status = params.action === "APPROVE" ? "APPROVED" : "REJECTED";
  const rejectionReason = params.action === "REJECT" ? params.rejectionReason : null;

  const record = await tx.kycRecord.update({
    where: { id: params.kycRecordId },
    data: { status, reviewedByAdminId: params.adminId, reviewedAt: new Date(), rejectionReason },
  });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: params.action === "APPROVE" ? "KYC_APPROVAL" : "KYC_REJECTION",
      entityType: "KycRecord",
      entityId: params.kycRecordId,
      oldValue: { status: "PENDING" },
      newValue: { status, rejectionReason },
    },
  });

  return { id: record.id, status: record.status };
}

// Same decision shape as applyKycDecision above, applied to a Client's
// own ClientKycRecord instead of an Account's KycRecord -- see that
// model's own schema comment for why these stayed two separate tables.
// validateKycDecision (pure) is shared as-is; only the DB target and
// audit action/entityType differ.
export async function applyClientKycDecision(
  tx: Tx,
  params: { clientKycRecordId: string; brokerId: string; action: KycDecisionAction; rejectionReason: string; adminId: string }
): Promise<{ id: string; status: string }> {
  const status = params.action === "APPROVE" ? "APPROVED" : "REJECTED";
  const rejectionReason = params.action === "REJECT" ? params.rejectionReason : null;

  const record = await tx.clientKycRecord.update({
    where: { id: params.clientKycRecordId },
    data: { status, reviewedByAdminId: params.adminId, reviewedAt: new Date(), rejectionReason },
  });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: params.action === "APPROVE" ? "CLIENT_KYC_APPROVAL" : "CLIENT_KYC_REJECTION",
      entityType: "ClientKycRecord",
      entityId: params.clientKycRecordId,
      oldValue: { status: "PENDING" },
      newValue: { status, rejectionReason },
    },
  });

  return { id: record.id, status: record.status };
}
