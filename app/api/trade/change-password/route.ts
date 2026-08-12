import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (newPassword.length < 8) {
    return NextResponse.json({ error: "new password must be at least 8 characters" }, { status: 400 });
  }

  const account = await prisma.account.findUnique({ where: { id: session.accountId } });
  if (!account) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const currentMatches = await bcrypt.compare(currentPassword, account.passwordHash);
  if (!currentMatches) {
    return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  await prisma.account.update({
    where: { id: account.id },
    data: { passwordHash: newPasswordHash },
  });

  return NextResponse.json({ ok: true });
}
