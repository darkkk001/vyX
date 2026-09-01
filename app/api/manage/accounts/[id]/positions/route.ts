import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Minimal open-positions read for one account -- built for vyx-mt5-copier
// (a headless service on the Contabo box, docs handoff: VYX-MT5-COPIER-
// BRIEF.md), which REST-polls this every few seconds as a reconciliation
// pass alongside the gateway's admin event-stream (services/api-gateway/
// src/ws.ts's own internal-secret branch, same shared-secret convention).
// A real admin session still works too (unused by anything today, kept
// for parity/future reuse) since a bot holding the shared secret is a
// distinct trust boundary from a broker's own backoffice session, not a
// replacement for it.
//
// `id` accepts either the internal cuid or the human-facing account
// number -- a headless .env is far more naturally configured with the
// account number a broker actually sees ("50005702") than an opaque
// database id it would otherwise need a separate lookup step to resolve.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const internalSecretHeader = request.headers.get("x-internal-secret");
  const expectedSecret = process.env.INTERNAL_SERVICE_SECRET ?? "";
  const isInternal = !!expectedSecret && internalSecretHeader === expectedSecret;

  let brokerId: string | null = null;
  if (!isInternal) {
    const session = await getAdminSession();
    if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    brokerId = session!.brokerId!;
  }

  const account = await prisma.account.findFirst({
    where: { OR: [{ id }, { accountNumber: id }], ...(brokerId ? { brokerId } : {}) },
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
      id: p.id,
      symbol: p.symbol.name,
      side: p.side,
      volume: p.volume.toString(),
      openPrice: p.openPrice.toString(),
      openedAt: p.openedAt.toISOString(),
    })),
  });
}
