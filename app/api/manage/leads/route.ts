import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const leads = await prisma.lead.findMany({
    where: { brokerId: session.brokerId! },
    include: { convertedAccount: { select: { accountNumber: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    leads.map((l) => ({
      id: l.id,
      fullName: l.fullName,
      email: l.email,
      phone: l.phone,
      country: l.country,
      source: l.source,
      status: l.status,
      notes: l.notes,
      convertedAccountNumber: l.convertedAccount?.accountNumber ?? null,
      createdAt: l.createdAt.toISOString(),
    }))
  );
}

// MANAGER can add/manage leads -- this is CRM/dealing-desk activity, not
// finance (unlike converting one, which calls the existing BROKER_ADMIN-
// only POST /api/manage/accounts).
export async function POST(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!fullName || !email || !email.includes("@")) {
    return NextResponse.json({ error: "fullName and a valid email are required" }, { status: 400 });
  }
  const phone = typeof body?.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
  const country = typeof body?.country === "string" && body.country.trim() ? body.country.trim() : null;
  const source = typeof body?.source === "string" && body.source.trim() ? body.source.trim() : null;
  const notes = typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

  const lead = await prisma.lead.create({
    data: { brokerId: session.brokerId!, fullName, email, phone, country, source, notes },
  });

  return NextResponse.json({ id: lead.id }, { status: 201 });
}
