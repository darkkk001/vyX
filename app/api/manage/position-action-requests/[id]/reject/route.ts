import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { rejectPositionActionRequest } from "@/lib/position-actions";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const reviewNote = typeof body?.reviewNote === "string" ? body.reviewNote.trim().slice(0, 500) || null : null;

  const result = await prisma.$transaction((tx) => rejectPositionActionRequest(tx, { requestId: id, brokerId, adminId: session!.adminId, reviewNote }));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
