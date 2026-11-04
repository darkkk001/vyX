import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { crmStaff, clientRef, handleOf } from "@/lib/crm/core";
import { ticketRef } from "@/lib/room/support";

// Support tickets from the Trader's Room, staff side. GET ?status=OPEN|ANSWERED|RESOLVED|ALL -> the broker's tickets,
// waiting ones first.
export async function GET(request: NextRequest) {
  const g = await crmStaff("read");
  if ("response" in g) return g.response;
  const status = new URL(request.url).searchParams.get("status");
  const rows = await prisma.supportTicket.findMany({
    where: { brokerId: g.staff.brokerId, ...(status && status !== "ALL" ? { status: status as "OPEN" | "ANSWERED" | "RESOLVED" } : {}) },
    select: { id: true, number: true, subject: true, status: true, createdAt: true, updatedAt: true, assignedAdminId: true, client: { select: { id: true, clientNumber: true, fullName: true } } },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: 500,
  });
  const admins = await prisma.adminUser.findMany({ where: { brokerId: g.staff.brokerId }, select: { id: true, email: true } });
  const handle = new Map(admins.map((a) => [a.id, handleOf(a.email)]));
  return NextResponse.json({
    tickets: rows.map((t) => ({
      id: t.id, ref: ticketRef(t.number), subject: t.subject, status: t.status, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(),
      client: { id: t.client.id, ref: clientRef(t.client.clientNumber), fullName: t.client.fullName },
      owner: t.assignedAdminId ? handle.get(t.assignedAdminId) ?? null : null,
    })),
  });
}
