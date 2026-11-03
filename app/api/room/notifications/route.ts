import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";

// The dashboard bell: the client's own notifications, the rows tied to one of their accounts. Staff rows have no
// accountId, so they can never match. GET lists the latest 20 and the unread count; POST marks them all read.
const own = (clientId: string, brokerId: string) => ({ brokerId, account: { clientId, brokerId } });

export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const where = own(ctx.session.clientId, ctx.session.brokerId);
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, title: true, body: true, readAt: true, createdAt: true } }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  return NextResponse.json({
    unread,
    items: rows.map((n) => ({ id: n.id, title: n.title, body: n.body === n.title ? "" : n.body, read: n.readAt !== null, at: n.createdAt.toISOString() })),
  });
}

export async function POST() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  await prisma.notification.updateMany({ where: { ...own(ctx.session.clientId, ctx.session.brokerId), readAt: null }, data: { readAt: new Date() } });
  return NextResponse.json({ unread: 0 });
}
