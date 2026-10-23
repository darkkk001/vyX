import { NextRequest, NextResponse } from "next/server";
import { toClientShape } from "@/lib/client-execution";
import { tradingRightsRefusal } from "@/lib/account-trading-rights";
import { loadAccountAskRules } from "@/lib/ask-markup";
import { getLivePriceRow } from "@/lib/live-price";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { announcePositionModified, refuseModify } from "@/lib/position-modify";

// Inline SL/TP edit on an open position — side-aware validated against the
// client-reported current price, same rule as order placement.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startedAt = Date.now();
  const res = await handleModify(request, params);
  res.headers.set("Server-Timing", `app;dur=${Date.now() - startedAt}`);
  return res;
}

async function handleModify(request: NextRequest, params: Promise<{ id: string }>) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const slPrice = body?.slPrice !== undefined ? (body.slPrice == null ? null : String(body.slPrice)) : undefined;
  const tpPrice = body?.tpPrice !== undefined ? (body.tpPrice == null ? null : String(body.tpPrice)) : undefined;

  // currentPrice from the client is no longer trusted (audit 2026-09-24, money): SL/TP are checked against the
  // server's own live close-side price below. Older terminals still send it; it is ignored when a live price exists.

  // Latency fix 1 (2026-09-26, docs/audit/2026-09-24/latency-breakdown.md): the position, its symbol, the broker's
  // symbol settings, the trading sessions and the live price in ONE wave (relation filters keyed by the position id,
  // one SQL statement each); rows read for a position that is not this account's are discarded unanswered.
  const bySymbolOfPosition = { positions: { some: { id } } };
  const symbolRead = prisma.symbol.findFirst({ where: bySymbolOfPosition, select: { digits: true, name: true, category: true, contractSize: true } });
  const [position, symbol, brokerSymbolRow, tradingSessions, live, rightsRow] = await Promise.all([
    prisma.position.findUnique({ where: { id } }),
    symbolRead,
    prisma.brokerSymbol.findFirst({ where: { brokerId: session.brokerId, symbol: bySymbolOfPosition }, select: { stopLevel: true } }),
    prisma.tradingSession.findMany({ where: { brokerSymbol: { brokerId: session.brokerId, symbol: bySymbolOfPosition } } }),
    symbolRead.then((s) => (s ? getLivePriceRow(s.name) : null)),
    prisma.account.findUnique({ where: { id: session.accountId }, select: { status: true, tradingRights: true } }),
  ]);
  if (!position || position.accountId !== session.accountId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  // per-account trading rights (2026-09-28): a read-only account changes nothing itself
  const rightsRefused = rightsRow ? tradingRightsRefusal(rightsRow, "modify") : null;
  if (rightsRefused) return rightsRefused;
  const brokerSymbol = brokerSymbolRow && symbol ? { ...brokerSymbolRow, symbol, tradingSessions } : null;

  // Same fix as position close (app/api/trade/positions/[id]/close/route.ts, 2026-09-05): a server-side market-state
  // check (real MARKET_CLOSED + next-open time, not "feed down"), then the server's own live close-side price and the
  // side-aware SL / TP / stops-level rule. All of it lives in lib/position-modify.ts, shared with modify-bulk.
  const askRuleFor = position.side === "SELL" && brokerSymbol && live ? await loadAccountAskRules(prisma, position.accountId, [position.symbolId]) : null;
  const refused = refuseModify({ position, brokerSymbol, symbolName: brokerSymbol?.symbol.name ?? null, live, askRuleFor, slPrice, tpPrice });
  if (refused) return NextResponse.json(refused.body, { status: refused.status });

  const updated = await prisma.position.update({
    where: { id },
    data: {
      ...(slPrice !== undefined ? { slPrice } : {}),
      ...(tpPrice !== undefined ? { tpPrice } : {}),
    },
  });
  const row = { ...updated, symbol: { name: symbol!.name, digits: symbol!.digits, contractSize: symbol!.contractSize } };
  await announcePositionModified({ session, before: position, row, symbolName: symbol!.name, slPrice, tpPrice });
  return NextResponse.json(toClientShape(row)); // client allow-list (lib/client-execution.ts)
}
