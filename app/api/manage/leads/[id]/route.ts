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
    const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
    if (notes && notes.length > 2000) {
      return NextResponse.json({ error: "notes must be at most 2000 characters" }, { status: 400 });
    }
    data.notes = notes;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  // Phase 2 batch 7 (issue 286): status / convert / notes changes write an audit row with the old and new values,
  // in the same transaction as the update
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.lead.update({ where: { id }, data });
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (row.status !== lead.status) { before.status = lead.status; after.status = row.status; }
    if (row.convertedAccountId !== lead.convertedAccountId) { before.convertedAccountId = lead.convertedAccountId; after.convertedAccountId = row.convertedAccountId; }
    if (row.notes !== lead.notes) { before.notes = lead.notes; after.notes = row.notes; }
    if (Object.keys(after).length > 0) {
      await tx.auditLog.create({
        data: {
          brokerId: session.brokerId!,
          actorAdminId: session.adminId,
          action: row.status === "CONVERTED" && lead.status !== "CONVERTED" ? "LEAD_CONVERTED" : "LEAD_UPDATED",
          entityType: "Lead",
          entityId: id,
          oldValue: { fullName: lead.fullName, ...before } as Prisma.InputJsonValue,
          newValue: { fullName: lead.fullName, ...after } as Prisma.InputJsonValue,
        },
      });
    }
    return row;
  });
  return NextResponse.json({ id: updated.id, status: updated.status, convertedAccountId: updated.convertedAccountId, notes: updated.notes });
}
