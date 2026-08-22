import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { generateTemporaryPassword } from "@/lib/passwords";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Generates a new random password for a trader's account and returns it
// once (never stored in plaintext, never echoed again after this
// response -- see lib/passwords.ts). The other end of the in-app
// "Forgot password?" flow (app/api/trade/forgot-password), reached from
// the Notification it created (app/manage/(shell)/notifications).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const account = await prisma.account.findUnique({ where: { id } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const password = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.$transaction([
    prisma.account.update({ where: { id: account.id }, data: { passwordHash } }),
    prisma.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "ACCOUNT_PASSWORD_RESET",
        entityType: "Account",
        entityId: account.id,
        newValue: { accountNumber: account.accountNumber },
      },
    }),
  ]);

  return NextResponse.json({ password });
}
