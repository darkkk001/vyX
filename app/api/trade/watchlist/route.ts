import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { getOrSeedWatchlist } from "@/lib/watchlist";

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const symbols = await getOrSeedWatchlist(session.accountId, session.brokerId);
  return NextResponse.json({ symbols });
}

// Add a symbol to the watchlist -- appended at the end. Idempotent: an
// already-present symbol is a no-op (the unique [accountId, symbolId]
// constraint), not an error, so the client doesn't need to check first.
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const symbolId = typeof body?.symbolId === "string" ? body.symbolId : "";
  if (!symbolId) {
    return NextResponse.json({ error: "symbolId is required" }, { status: 400 });
  }

  const brokerSymbol = await prisma.brokerSymbol.findFirst({
    where: { brokerId: session.brokerId, symbolId, enabled: true },
  });
  if (!brokerSymbol) {
    return NextResponse.json({ error: "symbol not enabled for this broker" }, { status: 404 });
  }

  const maxPosition = await prisma.watchlistItem.aggregate({
    where: { accountId: session.accountId },
    _max: { position: true },
  });
  await prisma.watchlistItem.upsert({
    where: { accountId_symbolId: { accountId: session.accountId, symbolId } },
    update: {},
    create: { accountId: session.accountId, symbolId, position: (maxPosition._max.position ?? -1) + 1 },
  });

  const symbols = await getOrSeedWatchlist(session.accountId, session.brokerId);
  return NextResponse.json({ symbols });
}

// Reset to default -- delete every row for this account; the next read
// (including this response's own) lazily reseeds the default set, same
// as a brand-new account.
export async function DELETE() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  await prisma.watchlistItem.deleteMany({ where: { accountId: session.accountId } });
  const symbols = await getOrSeedWatchlist(session.accountId, session.brokerId);
  return NextResponse.json({ symbols });
}
