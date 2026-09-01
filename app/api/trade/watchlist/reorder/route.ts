import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// Persist a full drag-to-reorder in one call -- small N (a watchlist,
// never hundreds of rows), so rewriting every position wholesale in one
// transaction is simpler and plenty fast, no fractional-index scheme
// needed. Takes symbol NAMES, not ids -- WebTrader.tsx's own
// watchlistOrder state is name-keyed throughout (it doubles as the key
// into `market`), so requiring ids here would mean a symbolIdFor() look
// up on every single row for no benefit; filtering through the `symbol`
// relation is one join, not meaningfully more expensive than filtering
// on symbolId directly. An id that isn't in this account's watchlist
// (stale client state, hidden by another tab/device in the meantime) is
// silently skipped rather than erroring the whole reorder.
export async function PUT(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const symbolNames = Array.isArray(body?.symbolNames) ? body.symbolNames.filter((s: unknown): s is string => typeof s === "string") : null;
  if (!symbolNames) {
    return NextResponse.json({ error: "symbolNames (string array) is required" }, { status: 400 });
  }

  await prisma.$transaction(
    symbolNames.map((symbolName: string, index: number) =>
      prisma.watchlistItem.updateMany({
        where: { accountId: session.accountId, symbol: { name: symbolName } },
        data: { position: index },
      })
    )
  );

  return NextResponse.json({ ok: true });
}
