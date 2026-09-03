import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const positions = await prisma.position.findMany({
    where: { accountId: session.accountId, status: "OPEN", deletedAt: null },
    include: { symbol: { select: { name: true, digits: true, contractSize: true } } },
    orderBy: { openedAt: "desc" },
  });
  return NextResponse.json(positions);
}
