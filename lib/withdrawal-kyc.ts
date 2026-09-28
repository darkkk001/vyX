import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// Owner decision 2026-09-27 (issue 132) + 2026-09-28: approved KYC gates WITHDRAWALS only -- not deposits, not trading.
// KYC counts when EITHER the trading account's own (in-app) KycRecord is APPROVED, OR the account belongs to a Client
// Portal client whose client-level KYC is APPROVED. Checked when the trader files a withdrawal AND again when an admin
// marks or completes one, so a request filed before this rule (or before a KYC was revoked) cannot be paid out either.
export const WITHDRAWAL_KYC_CODE = "KYC_REQUIRED";
export const WITHDRAWAL_KYC_MESSAGE = "Withdrawals need approved KYC. Complete your identity verification first; deposits and trading are not affected.";
export const WITHDRAWAL_KYC_ADMIN_MESSAGE = "withdrawal refused: this account's KYC is not approved (neither the account's own KYC nor its portal client's). Approve the KYC first, or reject the request";

export async function withdrawalKycApproved(db: Db, accountId: string): Promise<boolean> {
  const a = await db.account.findUnique({
    where: { id: accountId },
    select: { kycRecord: { select: { status: true } }, client: { select: { kycRecord: { select: { status: true } } } } },
  });
  return a?.kycRecord?.status === "APPROVED" || a?.client?.kycRecord?.status === "APPROVED";
}
