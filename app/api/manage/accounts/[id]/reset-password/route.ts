import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { revokeAllAccountSessions } from "@/lib/account-auth";
import { generateTemporaryPassword } from "@/lib/passwords";
import { emailNewPassword, requireAccountForCredentials } from "@/lib/account-credentials";

// Resets a trading account's password (docs/contracts/staff-credentials.md, owner 2026-10-05). The answer ALWAYS
// carries the new temporary password (the backoffice card shows it masked; revealing it is audited through
// password-revealed) plus whether it was e-mailed: {password, emailed, to, notEmailedReason}. Internal accounts are
// never e-mailed. The password is generated once, never stored in plaintext. Always audited (ACCOUNT_PASSWORD_RESET).
// Every existing session of the account is revoked with it: this is the broker's "this account is compromised"
// action, and until 2026-09-18 an attacker holding a session cookie simply kept trading through it.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAccountForCredentials(id);
  if (!gate.ok) return gate.response;
  const { account, adminId, brokerId } = gate;

  const password = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.$transaction([
    prisma.account.update({ where: { id: account.id }, data: { passwordHash } }),
    prisma.auditLog.create({
      data: {
        brokerId,
        actorAdminId: adminId,
        action: "ACCOUNT_PASSWORD_RESET",
        entityType: "Account",
        entityId: account.id,
        newValue: { accountNumber: account.accountNumber },
      },
    }),
  ]);
  await revokeAllAccountSessions(account.id);

  const outcome = await emailNewPassword(account, password, "reset");
  return NextResponse.json({ password, ...outcome });
}
