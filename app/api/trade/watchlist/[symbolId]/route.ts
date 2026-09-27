import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// "Hide symbol" -- a row's mere existence means "visible," so hiding is
// just deleting it. Idempotent: hiding an already-hidden (or never-added)
// symbol is a no-op, not an error.
export async function DELETE(_request: Request, { params }: { params: Promise<{ symbolId: string }> }) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { symbolId } = await params;
  // Phase 2 batch 6 (issue 234): an empty watchlist is re-seeded with the defaults on the next read, so removing the
  // LAST symbol silently brought the defaults back. Refuse it, with the reason; "reset to default" stays its own call.
  const [items, isMember] = await Promise.all([
    prisma.watchlistItem.count({ where: { accountId: session.accountId } }),
    prisma.watchlistItem.count({ where: { accountId: session.accountId, symbolId } }),
  ]);
  if (isMember > 0 && items <= 1) {
    return NextResponse.json({ error: "LAST_WATCHLIST_SYMBOL", message: "The watchlist needs at least one symbol. Add another symbol first." }, { status: 409 });
  }
  await prisma.watchlistItem.deleteMany({ where: { accountId: session.accountId, symbolId } });
  return NextResponse.json({ ok: true });
}
