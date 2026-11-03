import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { crmStaff } from "@/lib/crm/core";

// POST {entityType: "LEAD"|"CLIENT", entityId, body}: a staff note on a lead or client. On a lead it is also the last
// contact. Notes are never shown to the client.
export async function POST(request: NextRequest) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  const b = await request.json().catch(() => null);
  const entityType = b?.entityType === "LEAD" ? "LEAD" : b?.entityType === "CLIENT" ? "CLIENT" : null;
  const text = typeof b?.body === "string" ? b.body.trim().slice(0, 4000) : "";
  if (!entityType || typeof b?.entityId !== "string" || !text) return NextResponse.json({ error: "Write the note." }, { status: 400 });
  const exists = entityType === "LEAD"
    ? await prisma.lead.findFirst({ where: { id: b.entityId, brokerId: staff.brokerId }, select: { id: true } })
    : await prisma.client.findFirst({ where: { id: b.entityId, brokerId: staff.brokerId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const note = await prisma.crmNote.create({ data: { brokerId: staff.brokerId, entityType, entityId: b.entityId, authorAdminId: staff.adminId, body: text } });
  if (entityType === "LEAD") await prisma.lead.update({ where: { id: b.entityId }, data: { lastContactAt: note.createdAt } });
  return NextResponse.json({ id: note.id, at: note.createdAt.toISOString() }, { status: 201 });
}
