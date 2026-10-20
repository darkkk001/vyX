import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// GET /api/trade/deals: the account's deals, MT5 "Deals" view (deal model step 4, docs/POSITION-DEAL-MODEL.md 3.4).
// One row per execution: the opening IN, every OUT (partial or final close), both OUT_BY legs of a close-by, and the
// OUT + IN pair of a reverse in place (profit 0). Account-scoped by the session; voided trades and deleted positions are
// left out. Newest first; `from` / `to` filter on the deal's own execution time; `symbol` by name; `limit` 1..5000
// (1000 by default, 5000 when `from` bounds the window), like /api/trade/history.
//
// Row: ticket (deal ticket, its own sequence), positionTicket, symbol, digits, side (of THIS deal: the close of a BUY is a
// SELL), entry IN | OUT | OUT_BY, reason, source, volume, price, profit (= the TRADE_PNL amount of a close), commission,
// swap (this close's share), executedAt, byPositionTicket (close-by counterpart).
export async function GET(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const sp = new URL(request.url).searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
    return NextResponse.json({ error: "from / to must be ISO dates" }, { status: 400 });
  }
  const symbolName = sp.get("symbol");
  let symbolId: string | undefined;
  if (symbolName) {
    const s = await prisma.symbol.findUnique({ where: { name: symbolName }, select: { id: true } });
    if (!s) return NextResponse.json([]);
    symbolId = s.id;
  }

  const deals = await prisma.deal.findMany({
    where: {
      accountId: session.accountId,
      voidedAt: null,
      ...(symbolId ? { symbolId } : {}),
      ...(fromDate || toDate ? { executedAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } } : {}),
    },
    orderBy: [{ executedAt: "desc" }, { ticket: "desc" }],
    take: clampTake(sp.get("limit"), from ? 5000 : 1000),
  });
  if (deals.length === 0) return NextResponse.json([]);

  const positionIds = [...new Set(deals.flatMap((d) => (d.byPositionId ? [d.positionId, d.byPositionId] : [d.positionId])))];
  const [positions, symbols] = await Promise.all([
    prisma.position.findMany({ where: { id: { in: positionIds }, accountId: session.accountId }, select: { id: true, ticket: true, deletedAt: true } }),
    prisma.symbol.findMany({ where: { id: { in: [...new Set(deals.map((d) => d.symbolId))] } }, select: { id: true, name: true, digits: true } }),
  ]);
  const pos = new Map(positions.map((p) => [p.id, p]));
  const sym = new Map(symbols.map((s) => [s.id, s]));
  const rows = [];
  for (const d of deals) {
    const p = pos.get(d.positionId);
    if (!p || p.deletedAt) continue;
    const s = sym.get(d.symbolId);
    rows.push({
      ticket: Number(d.ticket),
      positionTicket: p.ticket,
      symbol: s?.name ?? null,
      digits: s?.digits ?? null,
      side: d.side,
      entry: d.entry,
      reason: d.reason,
      source: d.source,
      volume: d.volume.toString(),
      price: d.price.toString(),
      profit: d.profit.toString(),
      commission: d.commission.toString(),
      swap: d.swap.toString(),
      executedAt: d.executedAt.toISOString(),
      byPositionTicket: d.byPositionId ? pos.get(d.byPositionId)?.ticket ?? null : null,
    });
  }
  return NextResponse.json(rows);
}

function clampTake(raw: string | null, fallback: number): number {
  const n = raw ? Math.trunc(Number(raw)) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 5000) : fallback;
}
