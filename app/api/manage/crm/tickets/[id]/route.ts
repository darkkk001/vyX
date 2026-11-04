import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { crmStaff, clientRef, handleOf } from "@/lib/crm/core";
import { ticketRef } from "@/lib/room/support";
import { publishRoomChangedForClient } from "@/lib/room/events";

// One ticket, staff side. GET -> thread (staff named by handle here; the client sees "Support"). POST {body, resolve?}
// -> a reply (status ANSWERED, or RESOLVED with resolve: true); the client's room shows it at once. PATCH {status} ->
// RESOLVED / OPEN without a message.
async function own(brokerId: string, id: string) {
  return prisma.supportTicket.findFirst({ where: { id, brokerId }, select: { id: true, number: true, subject: true, status: true, createdAt: true, clientId: true, client: { select: { clientNumber: true, fullName: true, email: true } } } });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await crmStaff("read");
  if ("response" in g) return g.response;
  const { id } = await params;
  const t = await own(g.staff.brokerId, id);
  if (!t) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  const msgs = await prisma.supportTicketMessage.findMany({ where: { ticketId: t.id }, orderBy: { createdAt: "asc" } });
  const admins = await prisma.adminUser.findMany({ where: { id: { in: [...new Set(msgs.map((m) => m.authorAdminId).filter((x): x is string => !!x))] } }, select: { id: true, email: true } });
  const handle = new Map(admins.map((a) => [a.id, handleOf(a.email)]));
  return NextResponse.json({
    ticket: { id: t.id, ref: ticketRef(t.number), subject: t.subject, status: t.status, createdAt: t.createdAt.toISOString(), client: { id: t.clientId, ref: clientRef(t.client.clientNumber), fullName: t.client.fullName, email: t.client.email } },
    messages: msgs.map((m) => ({ id: m.id, from: m.authorAdminId ? handle.get(m.authorAdminId) ?? "STAFF" : "CLIENT", staff: !!m.authorAdminId, body: m.body, at: m.createdAt.toISOString() })),
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  const { id } = await params;
  const t = await own(staff.brokerId, id);
  if (!t) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  const b = await request.json().catch(() => null);
  const text = typeof b?.body === "string" ? b.body.trim().slice(0, 5000) : "";
  if (!text) return NextResponse.json({ error: "Write the reply." }, { status: 400 });
  const resolve = b?.resolve === true;
  const now = new Date();
  await prisma.$transaction([
    prisma.supportTicketMessage.create({ data: { ticketId: t.id, authorAdminId: staff.adminId, body: text, createdAt: now } }),
    prisma.supportTicket.update({ where: { id: t.id }, data: { status: resolve ? "RESOLVED" : "ANSWERED", updatedAt: now, resolvedAt: resolve ? now : null, assignedAdminId: staff.adminId } }),
  ]);
  await publishRoomChangedForClient(staff.brokerId, t.clientId, "support");
  await prisma.auditLog.create({ data: { brokerId: staff.brokerId, actorAdminId: staff.adminId, clientId: t.clientId, action: resolve ? "SUPPORT_TICKET_RESOLVED" : "SUPPORT_TICKET_ANSWERED", entityType: "SupportTicket", entityId: t.id, newValue: { ref: ticketRef(t.number) } } });
  return NextResponse.json({ status: resolve ? "RESOLVED" : "ANSWERED" }, { status: 201 });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  const { id } = await params;
  const t = await own(staff.brokerId, id);
  if (!t) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  const b = await request.json().catch(() => null);
  const status = b?.status === "RESOLVED" ? "RESOLVED" : b?.status === "OPEN" ? "OPEN" : null;
  if (!status) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
  const now = new Date();
  await prisma.supportTicket.update({ where: { id: t.id }, data: { status, updatedAt: now, resolvedAt: status === "RESOLVED" ? now : null } });
  await publishRoomChangedForClient(staff.brokerId, t.clientId, "support");
  await prisma.auditLog.create({ data: { brokerId: staff.brokerId, actorAdminId: staff.adminId, clientId: t.clientId, action: status === "RESOLVED" ? "SUPPORT_TICKET_RESOLVED" : "SUPPORT_TICKET_REOPENED", entityType: "SupportTicket", entityId: t.id, newValue: { ref: ticketRef(t.number) } } });
  return NextResponse.json({ status });
}
