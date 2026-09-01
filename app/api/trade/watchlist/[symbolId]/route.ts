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
  await prisma.watchlistItem.deleteMany({ where: { accountId: session.accountId, symbolId } });
  return NextResponse.json({ ok: true });
}
