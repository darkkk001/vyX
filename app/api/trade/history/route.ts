import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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
  // Terminal 1.0.90 History (Deals and Positions views), opt-in. Without ?closes=1 everything below is today's answer,
  // unchanged (terminal <= 1.0.89 and WebTrader).
  if (searchParams.get("closes") === "1") return closesView(session.accountId, searchParams);

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
    select: { referenceId: true, amount: true, createdAt: true, note: true, closeVolume: true, closePrice: true, closeByPositionId: true },
  });
  const byPosition = new Map<string, CloseTx[]>();
  for (const t of txRows) if (t.referenceId) byPosition.set(t.referenceId, [...(byPosition.get(t.referenceId) ?? []), t]);
  const ids = new Set<string>(); const tickets = new Set<number>();
  for (const t of txRows) if (t.closeByPositionId) ids.add(t.closeByPositionId);
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

/** `?closes=1`: the terminal's Deals view (every close at its own time; a partial appears as soon as it is made) and
 *  Positions view (aggregated). A position is listed when at least one of its closes (a TRADE_PNL ledger row) falls in
 *  from / to, so `from` / `to` filter on each close's own time, not on Position.closedAt. OPEN positions already closed in
 *  part are included. Newest close first; `limit` counts positions as in the default answer (1000, or 5000 with `from`).
 *  Each row is the position with the same fields as the default answer, plus:
 *    closes           EVERY close of the position, oldest first, each with its own time, lots, price and P/L (lib/history-closes.ts,
 *                     from the ledger's close fields; always a list here, a single plain close included)
 *    closedVolume     lots closed so far: the sum of the closes (Position.closedVolume when a pre-hotfix close has no lots)
 *    remainingVolume  lots still open ("0" once CLOSED)
 *    closedPnl        the sum of the closes' P/L (the ledger amounts)
 *    avgClosePrice    the volume-weighted close price; null when a close has no lots or price
 *    lastCloseAt      the newest close's time (a client's incremental cursor: from = its newest lastCloseAt) */
async function closesView(accountId: string, sp: URLSearchParams) {
  const from = sp.get("from");
  const to = sp.get("to");
  const symbolName = sp.get("symbol");
  // the positions that can be listed: this account's, not deleted, open or closed (a VOIDED one never moved money)
  const eligible = await prisma.position.findMany({
    where: { accountId, deletedAt: null, status: { in: ["OPEN", "CLOSED"] }, ...(symbolName ? { symbol: { name: symbolName } } : {}) },
    select: { id: true },
  });
  if (eligible.length === 0) return NextResponse.json([]);
  const closeRows = { accountId, type: "TRADE_PNL" as const, referenceType: "Position" };
  const groups = await prisma.transaction.groupBy({
    by: ["referenceId"],
    where: {
      ...closeRows,
      referenceId: { in: eligible.map((p) => p.id) },
      ...(from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take: clampTake(sp.get("limit"), from ? 5000 : 1000),
  });
  const ids = groups.map((g) => g.referenceId).filter((id): id is string => !!id);
  if (ids.length === 0) return NextResponse.json([]);
  const positions = await prisma.position.findMany({
    where: { id: { in: ids }, accountId },
    include: { symbol: { select: { name: true, digits: true } }, originOrder: { select: { source: true } } },
  });
  // all closes of the listed positions (not only those in the range): the Deals view filters by each close's own time
  const txRows = await prisma.transaction.findMany({
    where: { ...closeRows, referenceId: { in: ids } },
    select: { referenceId: true, amount: true, createdAt: true, note: true, closeVolume: true, closePrice: true, closeByPositionId: true },
  });
  const byPosition = new Map<string, CloseTx[]>();
  for (const t of txRows) if (t.referenceId) byPosition.set(t.referenceId, [...(byPosition.get(t.referenceId) ?? []), t]);
  const cpIds = new Set<string>(); const cpTickets = new Set<number>();
  for (const t of txRows) if (t.closeByPositionId) cpIds.add(t.closeByPositionId);
  for (const t of txRows) { const target = closeByTarget(t.note); if (target) { if ("id" in target) cpIds.add(target.id); else cpTickets.add(target.ticket); } }
  const counterparts: Counterpart[] = cpIds.size + cpTickets.size === 0 ? [] : await prisma.position.findMany({
    where: { accountId, OR: [{ id: { in: [...cpIds] } }, { ticket: { in: [...cpTickets] } }] },
    select: { id: true, ticket: true, status: true, volume: true, closePrice: true, closedAt: true },
  });
  const byId = new Map(positions.map((p) => [p.id, p]));
  const rows = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    const closes = closesOf(p, byPosition.get(id) ?? [], counterparts, { all: true }) ?? [];
    const zero = new Prisma.Decimal(0);
    const known = closes.every((c) => c.volume != null);
    const priced = known && closes.every((c) => c.price != null);
    const lots = closes.reduce((s, c) => (c.volume != null ? s.add(c.volume) : s), zero);
    const avg = priced && lots.gt(0) ? closes.reduce((s, c) => s.add(new Prisma.Decimal(c.volume!).mul(c.price!)), zero).div(lots) : null;
    rows.push({
      ...p,
      closes,
      closedVolume: known ? lots.toString() : p.closedVolume?.toString() ?? null,
      remainingVolume: p.status === "OPEN" ? p.volume.toString() : "0",
      closedPnl: closes.reduce((s, c) => s.add(c.pnl), zero).toString(),
      avgClosePrice: avg ? avg.toDecimalPlaces(p.symbol.digits).toString() : null,
      lastCloseAt: closes.length > 0 ? closes[closes.length - 1].at : null,
    });
  }
  return NextResponse.json(rows);
}

function clampTake(raw: string | null, fallback: number): number {
  const n = raw ? Math.trunc(Number(raw)) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 5000) : fallback;
}
