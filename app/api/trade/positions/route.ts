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
    include: {
      symbol: { select: { name: true, digits: true, contractSize: true } },
      // Order-origin tracking -- surfaces which client actually placed
      // this position's originating order (native terminal hover/
      // backoffice column), joined through the strict 1:1 originOrderId
      // relation rather than duplicating a source field onto Position
      // itself.
      originOrder: { select: { source: true } },
    },
    orderBy: { openedAt: "desc" },
  });
  return NextResponse.json(positions);
}
