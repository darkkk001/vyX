import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

export async function GET(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const symbolName = searchParams.get("symbol");

  const trades = await prisma.position.findMany({
    where: {
      accountId: session.accountId,
      status: "CLOSED",
      deletedAt: null,
      // `from`/`to` arrive as full ISO instants -- the trader's own local
      // day boundaries, converted client-side (WebTrader.tsx's
      // localDayBoundary) before ever reaching this route. Parsing them
      // directly here (no re-templating) is what fixes the previous
      // inconsistency: `from` used to parse as UTC midnight while `to`
      // parsed as a bare local-server-time string, silently disagreeing
      // with each other and with neither matching the trader's own
      // timezone (2026-09-06 Section C audit fix).
      ...(from || to
        ? {
            closedAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
      ...(symbolName ? { symbol: { name: symbolName } } : {}),
    },
    include: { symbol: { select: { name: true, digits: true } } },
    orderBy: { closedAt: "desc" },
  });
  return NextResponse.json(trades);
}
