import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientSession } from "@/lib/client-auth";

// Confirms the whole Stage 1 auth loop actually holds together end to
// end (register -> verify -> login -> session persists), same role
// app/api/trade/me plays for the trader session. Stage 2's portal
// dashboard is the real consumer; this exists now so the auth core is
// independently testable before any UI does.
export async function GET() {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const client = await prisma.client.findUnique({
    where: { id: session.clientId },
    select: { id: true, email: true, fullName: true, emailVerifiedAt: true, status: true, createdAt: true },
  });
  if (!client) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  return NextResponse.json(client);
}
