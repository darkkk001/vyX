import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { hedgeExposure, hedgeOutcome, type HedgeOutcome } from "@/lib/hedge-view";
import { autoHedgesOnFill, hedgeRouteOfCategory } from "@/lib/hedge-route";

// QoreBridge M5: the backoffice Liquidity tab's HEDGES view and its UNHEDGED EXPOSURE indicator. Plain outcomes only
// (brokers never see LP / FIX / bridge internals; a leg's technical reason stays in HedgeResult.reason for
// super-admin telemetry). Read-only.
//
//   exposure  per symbol: the clients' net A-book lots (open positions that were A-book at open) against the lots
//             the liquidity providers filled for them; unhedged = the difference. Computed from both sides, so it
//             self-corrects (an open that was never hedged and then closed nets to zero on the client side, and the
//             LP's leftover shows as unhedged until a dealer acts).
//   hedges    the newest intents (one per client deal), each with its outcome, filled lots, LP price and slippage.
//   routes    per group, which way its positions are hedged (owner 2026-10-26, the Liquidity screen's line per group):
//             LIQUIDITY_PROVIDER (A-book) or HEDGE_ACCOUNT (hand hedge; plus automatic when autoHedge), never both.
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export async function GET(req: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const [clientRows, lpRows, waiting, intents, groups, broker] = await Promise.all([
    prisma.$queryRaw<{ symbol: string; net: Prisma.Decimal }[]>`
      SELECT s."name" AS symbol, SUM(CASE WHEN p."side" = 'BUY' THEN p."volume" ELSE -p."volume" END) AS net
      FROM "Position" p JOIN "Symbol" s ON s."id" = p."symbolId"
      WHERE p."brokerId" = ${brokerId} AND p."status" = 'OPEN' AND p."groupCategoryAtOpen" = 'A_BOOK'
      GROUP BY s."name"`,
    prisma.$queryRaw<{ symbol: string; net: Prisma.Decimal }[]>`
      SELECT h."symbol", SUM(CASE WHEN h."side" = 'BUY' THEN r."filledVolume" ELSE -r."filledVolume" END) AS net
      FROM "HedgeResult" r JOIN "HedgeIntent" h ON h."id" = r."intentId"
      WHERE h."brokerId" = ${brokerId}
      GROUP BY h."symbol"`,
    prisma.hedgeIntent.count({ where: { brokerId, status: { in: ["PENDING", "CLAIMED"] } } }),
    prisma.hedgeIntent.findMany({ where: { brokerId }, orderBy: { seq: "desc" }, take: limit }),
    prisma.group.findMany({ where: { brokerId }, select: { id: true, name: true, category: true }, orderBy: { name: "asc" } }),
    prisma.broker.findUnique({ where: { id: brokerId }, select: { autoHedgeAt: true, dealingDeskAutoFillAt: true } }),
  ]);
  // auto-hedge runs only while it is on and the desk auto-fills (lib/coverage.ts onFillAutoHedge)
  const autoHedgeOn = Boolean(broker?.autoHedgeAt && broker.dealingDeskAutoFillAt);
  const routes = groups
    .filter((g) => g.category !== "COVERAGE")
    .map((g) => ({ groupId: g.id, name: g.name, category: g.category, route: hedgeRouteOfCategory(g.category), autoHedge: autoHedgeOn && autoHedgesOnFill(g.category) }));

  const ids = intents.map((i) => i.id);
  const [legs, positions, accounts] = await Promise.all([
    prisma.hedgeResult.findMany({ where: { intentId: { in: ids } } }),
    prisma.position.findMany({ where: { id: { in: [...new Set(intents.map((i) => i.positionId))] } }, select: { id: true, ticket: true } }),
    prisma.account.findMany({ where: { id: { in: [...new Set(intents.map((i) => i.accountId))] } }, select: { id: true, accountNumber: true } }),
  ]);
  const providers = await prisma.liquidityProvider.findMany({
    where: { brokerId, id: { in: [...new Set(legs.map((l) => l.liquidityProviderId))] } },
    select: { id: true, name: true },
  });
  const providerName = new Map(providers.map((p) => [p.id, p.name]));
  const ticket = new Map(positions.map((p) => [p.id, p.ticket.toString()]));
  const accountNumber = new Map(accounts.map((a) => [a.id, a.accountNumber]));
  const legsByIntent = new Map<string, typeof legs>();
  for (const l of legs) legsByIntent.set(l.intentId, [...(legsByIntent.get(l.intentId) ?? []), l]);

  const hedges = intents.map((i) => {
    const own = legsByIntent.get(i.id) ?? [];
    const v = hedgeOutcome(i, own);
    return {
      id: i.id,
      createdAt: i.createdAt.toISOString(),
      accountNumber: accountNumber.get(i.accountId) ?? "",
      positionTicket: ticket.get(i.positionId) ?? "",
      symbol: i.symbol,
      side: i.side,
      kind: i.kind,
      reason: i.reason,
      volume: i.volume.toString(),
      clientPrice: i.clientPrice?.toString() ?? null,
      outcome: v.outcome satisfies HedgeOutcome,
      filledVolume: v.filled.toString(),
      lpPrice: v.lpPrice?.toString() ?? null,
      // in the broker's favour = positive: an LP buy below / sell above the client's price
      slippage: v.slippage?.toString() ?? null,
      providers: [...new Set(own.map((l) => providerName.get(l.liquidityProviderId) ?? "Unknown provider"))],
    };
  });

  const exposure = hedgeExposure(clientRows, lpRows);
  return NextResponse.json({
    unhedged: exposure.some((e) => e.unhedgedLots !== "0"),
    waiting,
    needsAttention: hedges.filter((h) => h.outcome === "NOT_HEDGED" || h.outcome === "PART_HEDGED" || h.outcome === "NEEDS_ATTENTION").length,
    exposure,
    hedges,
    routes,
  });
}
