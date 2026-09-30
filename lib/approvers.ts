import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// web5 (issues.md 71, owner 2026-09-30): "never self- or peer-approve; when no eligible approver exists (e.g. a
// manager-only broker) the request is refused with 'needs a broker admin'."
//
// An eligible approver of a maker-checker request is the same rule the approve routes already enforce: another
// ACTIVE staff member of the same broker (never the requester) who is a BROKER_ADMIN, or a MANAGER holding the
// permission the approval needs (ACCOUNT_FINANCE for balance / position / transfer / partner-pay requests,
// FUNDS_APPROVAL for a withdrawal someone marked). Checked when the request is FILED, so nobody files a request
// that nobody can ever approve. The approve paths themselves are unchanged (still never the requester).
export const NEEDS_BROKER_ADMIN = "needs a broker admin: no other staff member of this broker can approve this request";

export async function hasEligibleApprover(db: Db, brokerId: string, requesterId: string, permission: "ACCOUNT_FINANCE" | "FUNDS_APPROVAL"): Promise<boolean> {
  const n = await db.adminUser.count({
    where: {
      brokerId,
      status: "ACTIVE",
      id: { not: requesterId },
      OR: [{ role: "BROKER_ADMIN" }, { role: "MANAGER", extraPermissions: { has: permission } }],
    },
  });
  return n > 0;
}
