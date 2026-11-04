import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { createNotification } from "@/lib/notifications";
import { ticketRef } from "@/lib/room/support";

// One of the client's own tickets. GET -> the thread (staff shown as "Support", never by name). POST {body} -> the
// client's reply; a resolved ticket opens again.
async function own(clientId: string, brokerId: string, id: string) {
  return prisma.supportTicket.findFirst({ where: { id, clientId, brokerId }, select: { id: true, number: true, subject: true, status: true, createdAt: true, updatedAt: true, resolvedAt: true } });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { id } = await params;
  const t = await own(ctx.session.clientId, ctx.session.brokerId, id);
  if (!t) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  const messages = await prisma.supportTicketMessage.findMany({ where: { ticketId: t.id }, select: { id: true, authorAdminId: true, body: true, createdAt: true }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({
    ticket: { id: t.id, ref: ticketRef(t.number), subject: t.subject, status: t.status, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), resolvedAt: t.resolvedAt?.toISOString() ?? null },
    messages: messages.map((m) => ({ id: m.id, from: m.authorAdminId ? "support" : "client", body: m.body, at: m.createdAt.toISOString() })),
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-ticket-reply:${session.clientId}`, 20, 600);
  if (!allowed) return NextResponse.json({ error: "Too many messages. Try again later." }, { status: 429 });
  const { id } = await params;
  const t = await own(session.clientId, session.brokerId, id);
  if (!t) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  const body = await request.json().catch(() => null);
  const text = typeof body?.body === "string" ? body.body.trim().slice(0, 5000) : "";
  if (!text) return NextResponse.json({ error: "Write your message." }, { status: 400 });
  const now = new Date();
  await prisma.$transaction([
    prisma.supportTicketMessage.create({ data: { ticketId: t.id, body: text, createdAt: now } }),
    prisma.supportTicket.update({ where: { id: t.id }, data: { status: "OPEN", updatedAt: now, resolvedAt: null } }),
  ]);
  await createNotification(prisma, {
    brokerId: session.brokerId, type: "SUPPORT_TICKET", title: `Reply on ${ticketRef(t.number)}`,
    body: t.subject, entityType: "SupportTicket", entityId: t.id,
  });
  return NextResponse.json({ status: "sent" }, { status: 201 });
}
