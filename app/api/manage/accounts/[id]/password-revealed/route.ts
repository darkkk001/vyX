import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAccountForCredentials } from "@/lib/account-credentials";

// The backoffice calls this when staff click SHOW PASSWORD on the password card (owner 2026-10-05,
// docs/contracts/staff-credentials.md): who saw a client's password, and when, is on the audit log. The password
// itself is never sent here. Same gate as the reset.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAccountForCredentials(id);
  if (!gate.ok) return gate.response;
  await prisma.auditLog.create({
    data: {
      brokerId: gate.brokerId,
      actorAdminId: gate.adminId,
      action: "PASSWORD_REVEALED",
      entityType: "Account",
      entityId: gate.account.id,
      newValue: { accountNumber: gate.account.accountNumber },
    },
  });
  return NextResponse.json({ ok: true });
}
