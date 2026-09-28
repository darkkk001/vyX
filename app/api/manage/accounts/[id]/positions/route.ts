import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Minimal open-positions read for one account, for a staff session (MANAGER / BROKER_ADMIN / read-only SUPPORT) of the
// account's own broker. `id` accepts the internal cuid or the account number.
//
// Phase 2 batch 8 (issue 202, owner decision 2026-09-28): the x-internal-secret branch is GONE. It was built for a
// headless vyx-mt5-copier (not in this repo) and skipped broker scoping entirely: anyone holding the internal service
// secret could read any tenant's account, by id or account number. A copier that still needs this must sign in as a
// broker's staff account (scoped) or get a new, broker-scoped route.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role, lib/permissions.ts isSupportReader */ || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const account = await prisma.account.findFirst({
    where: { OR: [{ id }, { accountNumber: id }], brokerId },
    select: { id: true, brokerId: true },
  });
  if (!account) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const positions = await prisma.position.findMany({
    where: { accountId: account.id, status: "OPEN" },
    include: { symbol: { select: { name: true } } },
    orderBy: { openedAt: "asc" },
  });

  return NextResponse.json({
    accountId: account.id,
    brokerId: account.brokerId,
    positions: positions.map((p) => ({
      ticket: p.ticket,
      id: p.id,
      symbol: p.symbol.name,
      side: p.side,
      volume: p.volume.toString(),
      openPrice: p.openPrice.toString(),
      openedAt: p.openedAt.toISOString(),
    })),
  });
}
