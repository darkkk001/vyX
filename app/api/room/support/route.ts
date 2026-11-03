import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { createNotification } from "@/lib/notifications";
import { ticketRef } from "@/lib/room/support";

// Trader's Room support. GET -> the client's tickets, newest activity first. POST {subject, body} -> a new ticket with
// its first message; the broker sees it in the backoffice (notification + the tickets list).
export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const tickets = await prisma.supportTicket.findMany({
    where: { clientId: ctx.session.clientId, brokerId: ctx.session.brokerId },
    select: { id: true, number: true, subject: true, status: true, createdAt: true, updatedAt: true, resolvedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ tickets: tickets.map(shape) });
}

export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-ticket-new:${session.clientId}`, 5, 600);
  if (!allowed) return NextResponse.json({ error: "Too many new tickets. Try again later." }, { status: 429 });
  const body = await request.json().catch(() => null);
  const subject = typeof body?.subject === "string" ? body.subject.trim().slice(0, 120) : "";
  const text = typeof body?.body === "string" ? body.body.trim().slice(0, 5000) : "";
  if (!subject) return NextResponse.json({ error: "Add a subject." }, { status: 400 });
  if (!text) return NextResponse.json({ error: "Write your message." }, { status: 400 });
  const open = await prisma.supportTicket.count({ where: { clientId: session.clientId, status: { not: "RESOLVED" } } });
  if (open >= 10) return NextResponse.json({ error: "You have 10 open tickets. Reply in one of them." }, { status: 409 });

  const ticket = await prisma.supportTicket.create({
    data: { brokerId: session.brokerId, clientId: session.clientId, subject, messages: { create: { body: text } } },
    select: { id: true, number: true, subject: true, status: true, createdAt: true, updatedAt: true, resolvedAt: true },
  });
  const client = await prisma.client.findUnique({ where: { id: session.clientId }, select: { fullName: true } });
  await createNotification(prisma, {
    brokerId: session.brokerId, type: "SUPPORT_TICKET", title: `New ticket ${ticketRef(ticket.number)}`,
    body: `${client?.fullName ?? "A client"}: ${subject}`, entityType: "SupportTicket", entityId: ticket.id,
  });
  await prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "SUPPORT_TICKET_OPENED", entityType: "SupportTicket", entityId: ticket.id, newValue: { subject, source: "CLIENT" } } });
  return NextResponse.json({ ticket: shape(ticket) }, { status: 201 });
}

function shape(t: { id: string; number: number; subject: string; status: string; createdAt: Date; updatedAt: Date; resolvedAt: Date | null }) {
  return { id: t.id, ref: ticketRef(t.number), subject: t.subject, status: t.status, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), resolvedAt: t.resolvedAt?.toISOString() ?? null };
}
