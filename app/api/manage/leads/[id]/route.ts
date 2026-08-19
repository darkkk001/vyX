import { NextRequest, NextResponse } from "next/server";
import type { Prisma, LeadStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

const VALID_STATUS = ["NEW", "CONTACTED", "QUALIFIED", "CONVERTED", "LOST"];

// Status changes (MANAGER+BROKER_ADMIN) and marking CONVERTED after the
// caller has already created the Account via the existing POST
// /api/manage/accounts (see LeadsManager.tsx's convert flow -- this
// route never creates an Account itself, just records the link).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead || lead.brokerId !== session.brokerId) {
    return NextResponse.json({ error: "lead not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const data: Prisma.LeadUpdateInput = {};

  if (body?.status != null) {
    if (!VALID_STATUS.includes(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    if (body.status === "CONVERTED" && !body.convertedAccountId) {
      return NextResponse.json({ error: "convertedAccountId is required when marking CONVERTED" }, { status: 400 });
    }
    data.status = body.status as LeadStatus;
  }
  if (typeof body?.convertedAccountId === "string") {
    const account = await prisma.account.findUnique({ where: { id: body.convertedAccountId } });
    if (!account || account.brokerId !== session.brokerId) {
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }
    data.convertedAccount = { connect: { id: body.convertedAccountId } };
  }
  if ("notes" in (body ?? {})) {
    data.notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await prisma.lead.update({ where: { id }, data });
  return NextResponse.json({ id: updated.id, status: updated.status, convertedAccountId: updated.convertedAccountId });
}
