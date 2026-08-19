import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const existing = await prisma.lpRoutingRule.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== session!.brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await prisma.lpRoutingRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
