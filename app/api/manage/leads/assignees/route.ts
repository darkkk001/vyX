import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// web3 (owner 2026-09-30): the staff a lead can be assigned to (CRM "Assign to staff…"), readable by anyone who can
// assign (MANAGER or BROKER_ADMIN; SUPPORT gets 403). Same broker, ACTIVE, role MANAGER or BROKER_ADMIN -- exactly
// the staff leads/[id] PATCH accepts. Deliberately narrow: { id, email } per row and nothing else (no role,
// permissions, 2FA or status), because a MANAGER must not learn more about other staff than whom to pick. Staff
// accounts have no name column, so the e-mail is the display name; the id is what the assign PATCH sends.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const staff = await prisma.adminUser.findMany({
    where: { brokerId: session!.brokerId!, status: "ACTIVE", role: { in: ["MANAGER", "BROKER_ADMIN"] } },
    select: { id: true, email: true },
    orderBy: { email: "asc" },
  });
  return NextResponse.json(staff.map((s) => ({ id: s.id, email: s.email })));
}
