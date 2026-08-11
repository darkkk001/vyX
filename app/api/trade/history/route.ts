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
      ...(from || to
        ? {
            closedAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(`${to}T23:59:59`) } : {}),
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
