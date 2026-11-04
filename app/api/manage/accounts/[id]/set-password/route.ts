import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { revokeAllAccountSessions } from "@/lib/account-auth";
import { emailNewPassword, PASSWORD_RULE_TEXT, passwordIsStrong, requireAccountForCredentials } from "@/lib/account-credentials";

// Staff set a password they chose (owner 2026-10-05, docs/contracts/staff-credentials.md). Same gate as the reset,
// same session revocation, audited ACCOUNT_PASSWORD_SET without the password, optional e-mail (never for an
// internal account). The password is not echoed back: staff typed it.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAccountForCredentials(id);
  if (!gate.ok) return gate.response;
  const { account, adminId, brokerId } = gate;

  const body = await request.json().catch(() => null);
  if (typeof body?.password !== "string" || typeof body?.emailToClient !== "boolean") {
    return NextResponse.json({ error: "password (text) and emailToClient (true / false) are required", code: "INVALID_BODY" }, { status: 400 });
  }
  const password: string = body.password;
  if (!passwordIsStrong(password)) {
    return NextResponse.json({ error: PASSWORD_RULE_TEXT, code: "WEAK_PASSWORD" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.$transaction([
    prisma.account.update({ where: { id: account.id }, data: { passwordHash } }),
    prisma.auditLog.create({
      data: {
        brokerId,
        actorAdminId: adminId,
        action: "ACCOUNT_PASSWORD_SET",
        entityType: "Account",
        entityId: account.id,
        newValue: { accountNumber: account.accountNumber, emailToClient: body.emailToClient && !account.isInternal },
      },
    }),
  ]);
  await revokeAllAccountSessions(account.id);

  if (!body.emailToClient && !account.isInternal) {
    return NextResponse.json({ emailed: false, to: null, notEmailedReason: "NOT_REQUESTED" });
  }
  return NextResponse.json(await emailNewPassword(account, password, "set"));
}
