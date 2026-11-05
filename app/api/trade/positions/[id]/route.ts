import { NextRequest, NextResponse } from "next/server";
import { withClientRefusals } from "@/lib/client-reason";
import { traceCloseOrModifyRefusals } from "@/lib/rejected-orders";
import { toClientShape } from "@/lib/client-execution";
import { tradingRightsRefusal } from "@/lib/account-trading-rights";
import { loadAccountAskRules } from "@/lib/ask-markup";
import { getLivePriceRow } from "@/lib/live-price";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { announcePositionModified, loadAmountContext, refuseModify } from "@/lib/position-modify";
import { amountRefusalBody, legWrite, parseAmountLegs, setsAnAmount } from "@/lib/amount-sltp";

// Inline SL/TP edit on an open position — side-aware validated against the
// client-reported current price, same rule as order placement.
async function patchInner(
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
  // amount SL / TP (lib/amount-sltp.ts): a leg is a price OR an amount; setting one unit clears the other
  const amountLegs = parseAmountLegs(body);
  if (!amountLegs.ok) return NextResponse.json(amountRefusalBody(amountLegs.code, amountLegs.error), { status: 400 });
  const slLeg = legWrite(body?.slPrice !== undefined ? (body.slPrice == null ? null : String(body.slPrice)) : undefined, amountLegs.slAmount);
  const tpLeg = legWrite(body?.tpPrice !== undefined ? (body.tpPrice == null ? null : String(body.tpPrice)) : undefined, amountLegs.tpAmount);
  const { price: slPrice, amount: slAmount } = slLeg;
  const { price: tpPrice, amount: tpAmount } = tpLeg;

  // currentPrice from the client is no longer trusted (audit 2026-09-24, money): SL/TP are checked against the
  // server's own live close-side price below. Older terminals still send it; it is ignored when a live price exists.

  // Latency fix 1 (2026-09-26, docs/audit/2026-09-24/latency-breakdown.md): the position, its symbol, the broker's
  // symbol settings, the trading sessions and the live price in ONE wave (relation filters keyed by the position id,
  // one SQL statement each); rows read for a position that is not this account's are discarded unanswered.
  const bySymbolOfPosition = { positions: { some: { id } } };
  const symbolRead = prisma.symbol.findFirst({ where: bySymbolOfPosition, select: { digits: true, name: true, category: true, contractSize: true, quoteCurrency: true } });
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
  // an amount being SET: the RUST-authority refusal, the account currency and the conversion rate (price-only edits read nothing extra)
  const amountCtx = setsAnAmount(amountLegs) ? await loadAmountContext(position.accountId, symbol?.quoteCurrency ?? null) : null;
  if (amountCtx?.refused) return NextResponse.json(amountCtx.refused.body, { status: amountCtx.refused.status });
  const refused = refuseModify({ position, brokerSymbol, symbolName: brokerSymbol?.symbol.name ?? null, live, askRuleFor, slPrice, tpPrice, slAmount, tpAmount, fxRate: amountCtx?.fxRate, accountCurrency: amountCtx?.currency });
  if (refused) return NextResponse.json(refused.body, { status: refused.status });

  const updated = await prisma.position.update({
    where: { id },
    data: {
      ...(slPrice !== undefined ? { slPrice } : {}),
      ...(tpPrice !== undefined ? { tpPrice } : {}),
      ...(slAmount !== undefined ? { slAmount } : {}),
      ...(tpAmount !== undefined ? { tpAmount } : {}),
    },
  });
  const row = { ...updated, symbol: { name: symbol!.name, digits: symbol!.digits, contractSize: symbol!.contractSize } };
  await announcePositionModified({ session, before: position, row, symbolName: symbol!.name, slPrice, tpPrice, slAmount, tpAmount });
  return NextResponse.json(toClientShape(row)); // client allow-list (lib/client-execution.ts)
}

// Refusals answer with clientReason only (owner 2026-10-23, lib/client-reason.ts); close / modify refusals are traced first.
export async function PATCH(request: Parameters<typeof patchInner>[0], ctx: { params: Promise<{ id: string }> }) {
  const requestedAt = new Date();
  const raw = await patchInner(request, ctx);
  await traceCloseOrModifyRefusals("MODIFY", raw, request.headers, requestedAt, (await ctx.params).id);
  return withClientRefusals(raw);
}
