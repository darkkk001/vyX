import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { issueWsTicket } from "@/lib/account-auth";

// POST: one single-use observer ticket per own account (at most 10) for the gateway's trading stream. The room hears
// each account's events (balance, positions, terms, room.>) without counting the account as online.
export async function POST() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const accounts = await prisma.account.findMany({ where: { clientId: session.clientId, brokerId: session.brokerId, status: { not: "CLOSED" } }, select: { id: true }, take: 10, orderBy: { createdAt: "asc" } });
  const tickets = await Promise.all(accounts.map(async (a) => ({ accountId: a.id, ticket: await issueWsTicket(a.id, session.brokerId, { observer: true }) })));
  return NextResponse.json({ tickets }, { headers: { "Cache-Control": "no-store" } });
}
