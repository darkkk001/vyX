import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { closeByTarget, closesOf, type CloseTx, type Counterpart } from "@/lib/history-closes";

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
    include: {
      symbol: { select: { name: true, digits: true } },
      originOrder: { select: { source: true } },
    },
    orderBy: { closedAt: "desc" },
    // Phase 2 batch 3 (audit term-account / term-tabs lines): never the account's whole lifetime in one answer. Newest
    // first; `limit` (1..5000) or 1000 by default, 5000 when a `from` bounds the window. A client that already has
    // history asks with from = its newest closedAt and gets only what is new.
    take: clampTake(searchParams.get("limit"), from ? 5000 : 1000),
  });
  // Terminal 1.0.69 (grouped History): a position that was closed in parts, or against another position (close-by), also
  // carries `closes` -- one entry per close (volume, price, P/L, time, the ticket it was closed against). Derived from the
  // TRADE_PNL transactions that reference the position (lib/history-closes.ts); absent on a plain single close.
  const txRows = trades.length === 0 ? [] : await prisma.transaction.findMany({
    where: { accountId: session.accountId, type: "TRADE_PNL", referenceType: "Position", referenceId: { in: trades.map((t) => t.id) } },
    select: { referenceId: true, amount: true, createdAt: true, note: true },
  });
  const byPosition = new Map<string, CloseTx[]>();
  for (const t of txRows) if (t.referenceId) byPosition.set(t.referenceId, [...(byPosition.get(t.referenceId) ?? []), t]);
  const ids = new Set<string>(); const tickets = new Set<number>();
  for (const t of txRows) { const target = closeByTarget(t.note); if (target) { if ("id" in target) ids.add(target.id); else tickets.add(target.ticket); } }
  const counterparts: Counterpart[] = ids.size + tickets.size === 0 ? [] : await prisma.position.findMany({
    where: { accountId: session.accountId, OR: [{ id: { in: [...ids] } }, { ticket: { in: [...tickets] } }] },
    select: { id: true, ticket: true, status: true, volume: true, closePrice: true, closedAt: true },
  });
  return NextResponse.json(trades.map((t) => {
    const closes = closesOf(t, byPosition.get(t.id) ?? [], counterparts);
    return closes ? { ...t, closes } : t;
  }));
}

function clampTake(raw: string | null, fallback: number): number {
  const n = raw ? Math.trunc(Number(raw)) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 5000) : fallback;
}
