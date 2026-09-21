import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertAccountStructure, AccountStructureError } from "@/lib/account-structure";

// Extracted out of app/api/manage/accounts/route.ts's own createAccount
// (Manager's Add Account form) -- same numeric-safe sequential account
// number allocation, same retry-on-race loop, same initial-balance
// Transaction + audit log shape. Now shared with the Client Portal's own
// self-service Demo creation and Live-account-request approval (see
// app/api/portal/accounts/route.ts and
// app/api/manage/live-account-requests/[id]/route.ts) instead of three
// drifting copies of "create an Account safely."

// Numeric MAX via a raw cast, not `orderBy: { accountNumber: "desc" }` --
// accountNumber is a Prisma String column, so that `desc` sort is
// lexicographic, not numeric -- see the original route's own comment for
// the real incident this avoids.
export async function allocateAccountNumber(): Promise<string> {
  const rows = await prisma.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX("accountNumber"::bigint) as max FROM "Account" WHERE "accountNumber" ~ '^[0-9]+$'
  `;
  const base = rows[0]?.max != null ? Number(rows[0].max) : 50000999;
  return String((Number.isFinite(base) ? base : 50000999) + 1).padStart(8, "0");
}

export type ProvisionAccountParams = {
  brokerId: string;
  fullName: string;
  email: string;
  passwordHash: string;
  accountMode: "DEMO" | "LIVE";
  accountTypeId: string | null;
  currency: string;
  leverage: number;
  // Callers may still pass null (they resolve the broker's default group and
  // it may be missing); provisionAccount rejects that with NO_GROUP_AVAILABLE
  // rather than letting it reach the NOT NULL column.
  groupId: string | null;
  initialBalance: Prisma.Decimal;
  country: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
  // Client Portal ownership link -- null for an admin-created account not
  // tied to a self-service Client (the pre-Client-Portal, still-supported
  // path this same route already served).
  clientId: string | null;
  // Audit trail: which admin created this, if any. Null for a client's
  // own self-service Demo creation -- AuditLog.actorAdminId is nullable
  // for exactly this case.
  createdByAdminId: string | null;
  // Only lib/coverage.ts sets this, and only for the broker's own hedge
  // account -- the one account allowed into a COVERAGE group. Every other
  // caller leaves it unset and is refused there.
  allowCoverage?: boolean;
};

const MAX_ATTEMPTS = 5;

export async function provisionAccount(params: ProvisionAccountParams) {
  // Every account in this app is created through this function (Manager's
  // Add Account, the Client Portal's demo self-signup, live-account-request
  // approval, coverage provisioning), which makes it the one place the
  // mode-vs-group rules have to hold. Throws AccountStructureError; the
  // routes turn that into their own 400. See lib/account-structure.ts for
  // what is and is not a violation -- notably a DEMO account in a B_BOOK or
  // DEALING group is fine, and is exactly what the portal signup creates.
  // The account TYPE is deliberately not checked: it is the client-facing
  // spread tier and carries no routing, so any type is valid with any group.
  // Stage 3b made Account.groupId NOT NULL, so a null here is a constraint
  // violation rather than an ungrouped account. Every caller resolves the
  // broker's isDefault group when none was chosen, so null means that broker
  // has no default group at all, which is true of any broker created through
  // POST /api/admin/brokers (it provisions no groups; Stage 4 piece 6 fixes
  // that). Fail with something a human can act on, not a raw 23502.
  if (!params.groupId) {
    throw new AccountStructureError({
      code: "NO_GROUP_AVAILABLE",
      message: "this broker has no default group, so an account cannot be created yet; create a group and mark it default first",
    });
  }
  const group = await prisma.group.findUnique({
    where: { id: params.groupId },
    select: { id: true, category: true, modeRestriction: true },
  });
  assertAccountStructure({
    accountMode: params.accountMode,
    group,
    allowCoverage: params.allowCoverage === true,
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const accountNumber = await allocateAccountNumber();
    try {
      return await prisma.$transaction(async (tx) => {
        const account = await tx.account.create({
          data: {
            brokerId: params.brokerId,
            accountNumber,
            email: params.email,
            passwordHash: params.passwordHash,
            fullName: params.fullName,
            accountMode: params.accountMode,
            accountTypeId: params.accountTypeId,
            currency: params.currency,
            leverage: params.leverage,
            groupId: params.groupId!,  // non-null: guarded at the top of this function
            country: params.country,
            phone: params.phone,
            dateOfBirth: params.dateOfBirth,
            clientId: params.clientId,
          },
        });

        if (params.initialBalance.gt(0)) {
          await tx.account.update({ where: { id: account.id }, data: { balance: params.initialBalance } });
          await tx.transaction.create({
            data: {
              brokerId: params.brokerId,
              accountId: account.id,
              type: "ADJUSTMENT",
              status: "COMPLETED",
              amount: params.initialBalance,
              balanceBefore: new Prisma.Decimal(0),
              balanceAfter: params.initialBalance,
              note: "Initial balance on account creation",
              createdByAdminId: params.createdByAdminId,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            brokerId: params.brokerId,
            actorAdminId: params.createdByAdminId,
            action: "ACCOUNT_CREATED",
            entityType: "Account",
            entityId: account.id,
            oldValue: Prisma.JsonNull,
            newValue: {
              accountNumber,
              email: params.email,
              accountMode: params.accountMode,
              accountTypeId: params.accountTypeId,
              initialBalance: params.initialBalance.toString(),
            },
          },
        });

        return account;
      });
    } catch (error) {
      // accountNumber is the only unique constraint left on Account (see
      // its own schema comment -- the old [brokerId, email, accountMode]
      // constraint was dropped in the Client Portal Stage 1 migration),
      // so any P2002 here is a genuine allocation race worth retrying with
      // a freshly-read max, not a caller-facing validation error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && attempt < MAX_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("failed to allocate an account number after retries");
}
