import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getFreshPrice, getFreshPrices } from "@/lib/live-price";
import { conversionRate, loadFxLookup } from "@/lib/fx";
import { loadSellAskRules, valuationAsk } from "@/lib/ask-markup";
import { closePriceFor, computeRealizedPnl } from "@/lib/trading";
import { ensureCoverageAccount } from "@/lib/coverage";
import { hedgeRouteOf } from "@/lib/hedge-route";
import { writeOpenDealInTx } from "@/lib/deals";
import { publishTradingEvent } from "@/lib/nats";

// The hedge book per symbol (Dealing redesign D8 / D10, owner 2026-10-26). One server answer behind the Dealing HEDGE
// MANAGER and the hedge account panel, so their counts and tables never disagree, and the per-symbol Hedge action.
//   client positions: open, live client accounts (not internal, not the hedge account), whose hedge route is the hedge
//                     account (lib/hedge-route.ts: the broker's own book; an A-book group's position goes to the liquidity
//                     provider and is never here);
//   legs:             the open positions on the broker's hedge (coverage) account.
// D8: Hedge nets PER SYMBOL AND SIDE (owner 2026-10-26): every unhedged client position of a symbol on one side becomes
// ONE leg of their summed lots on the hedge account, on the SAME side as the clients (the side that flattens the broker's
// book, as BOOK NOW does); each client is marked covered and linked to that leg. A client's later close shrinks the shared
// leg by its share (lib/coverage.ts onClose).

const D0 = () => new Prisma.Decimal(0);
const lots = (d: Prisma.Decimal) => d.toFixed(2);

const SELECT = {
  id: true, ticket: true, accountId: true, symbolId: true, side: true, volume: true, openPrice: true, covered: true, coveragePositionId: true, bookType: true, groupCategoryAtOpen: true,
  account: { select: { accountNumber: true, fullName: true, currency: true } },
  symbol: { select: { name: true, contractSize: true, quoteCurrency: true } },
} as const;
type Pos = Prisma.PositionGetPayload<{ select: typeof SELECT }>;

/** The open client positions the hedge account may hedge (see the header). */
async function clientPositions(brokerId: string, coverageAccountId: string | null, symbols?: string[]): Promise<Pos[]> {
  const rows = await prisma.position.findMany({
    where: {
      brokerId, status: "OPEN", deletedAt: null, bookType: "B_BOOK",
      ...(symbols ? { symbol: { name: { in: symbols } } } : {}),
      account: { accountMode: "LIVE", isInternal: false, ...(coverageAccountId ? { id: { not: coverageAccountId } } : {}), group: { category: { not: "COVERAGE" } } },
    },
    select: SELECT,
    orderBy: { ticket: "asc" },
  });
  return rows.filter((p) => hedgeRouteOf(p) === "HEDGE_ACCOUNT");
}

/** Client-view floating P/L per position (account currency) at the margin pass's valuation; null = no price / FX rate. */
async function floating(ps: Pos[]): Promise<Map<string, Prisma.Decimal | null>> {
  const [prices, fx, askRules] = await Promise.all([
    getFreshPrices([...new Set(ps.map((p) => p.symbol.name))]),
    loadFxLookup(prisma, ps.map((p) => [p.symbol.quoteCurrency, p.account.currency] as const)),
    loadSellAskRules(prisma, ps),
  ]);
  const out = new Map<string, Prisma.Decimal | null>();
  for (const p of ps) {
    const live = prices.get(p.symbol.name);
    const rate = conversionRate(p.symbol.quoteCurrency, p.account.currency, fx);
    if (!live || !rate) { out.set(p.id, null); continue; }
    const close = closePriceFor(p.side, live.bid, valuationAsk(askRules, p, live.bid, live.ask));
    out.set(p.id, computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: close, volume: p.volume, contractSize: p.symbol.contractSize }).mul(rate));
  }
  return out;
}

const sumBy = (rows: { currency: string; amount: Prisma.Decimal }[]) => {
  const m = new Map<string, Prisma.Decimal>();
  for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? D0()).add(r.amount));
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) }));
};

/** D10: the hedge book, one row per symbol (clients and hedge-account legs together). */
export async function hedgeBook(brokerId: string) {
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { coverageAccountId: true } });
  const clients = await clientPositions(brokerId, broker.coverageAccountId);
  const legs = broker.coverageAccountId
    ? await prisma.position.findMany({ where: { accountId: broker.coverageAccountId, status: "OPEN", deletedAt: null }, select: SELECT, orderBy: { ticket: "asc" } })
    : [];
  const pnl = await floating([...clients, ...legs]);
  const legById = new Map(legs.map((l) => [l.id, l]));
  const clientsPerLeg = new Map<string, number>();
  for (const c of clients) if (c.covered && c.coveragePositionId) clientsPerLeg.set(c.coveragePositionId, (clientsPerLeg.get(c.coveragePositionId) ?? 0) + 1);

  const symbols = [...new Set([...clients, ...legs].map((p) => p.symbol.name))].sort();
  const rows = symbols.map((symbol) => {
    const cs = clients.filter((p) => p.symbol.name === symbol);
    const ls = legs.filter((p) => p.symbol.name === symbol);
    const side = (ps: Pos[], s: "BUY" | "SELL") => ps.filter((p) => p.side === s).reduce((t, p) => t.add(p.volume), D0());
    const buy = side(cs, "BUY"), sell = side(cs, "SELL");
    const hedged = cs.filter((p) => p.covered);
    const open = cs.filter((p) => !p.covered);
    const legBuy = side(ls, "BUY"), legSell = side(ls, "SELL");
    // the broker's side of its book: the clients' result reversed, plus the hedge legs' own result
    const bookFloating = sumBy([
      ...cs.map((p) => ({ currency: p.account.currency, amount: pnl.get(p.id)?.neg() ?? D0() })),
      ...ls.map((p) => ({ currency: p.account.currency, amount: pnl.get(p.id) ?? D0() })),
    ]);
    return {
      symbol,
      positions: cs.length,
      buyLots: lots(buy),
      sellLots: lots(sell),
      netLots: lots(buy.sub(sell)),
      hedgedLots: lots(hedged.reduce((t, p) => t.add(p.volume), D0())),
      unhedgedLots: lots(open.reduce((t, p) => t.add(p.volume), D0())),
      unhedged: { count: open.length, buyLots: lots(side(open, "BUY")), sellLots: lots(side(open, "SELL")) },
      bookFloating,
      unpriced: [...cs, ...ls].filter((p) => pnl.get(p.id) == null).length,
      clientPositions: cs.map((p) => ({
        positionId: p.id, ticket: p.ticket, accountNumber: p.account.accountNumber, name: p.account.fullName ?? "", side: p.side, lots: lots(p.volume),
        openPrice: p.openPrice.toString(), currency: p.account.currency, floatingPnl: pnl.get(p.id)?.toFixed(2) ?? null,
        covered: p.covered, legTicket: p.coveragePositionId ? (legById.get(p.coveragePositionId)?.ticket ?? null) : null,
      })),
      hedgeAccount: {
        buyLots: lots(legBuy),
        sellLots: lots(legSell),
        netLots: lots(legBuy.sub(legSell)),
        legs: ls.map((l) => ({
          positionId: l.id, ticket: l.ticket, side: l.side, lots: lots(l.volume), openPrice: l.openPrice.toString(), currency: l.account.currency,
          floatingPnl: pnl.get(l.id)?.toFixed(2) ?? null, clients: clientsPerLeg.get(l.id) ?? 0,
        })),
      },
    };
  });
  const total = (k: "positions") => rows.reduce((t, r) => t + r[k], 0);
  return {
    asOf: new Date().toISOString(),
    hedgeAccountId: broker.coverageAccountId,
    positions: total("positions"),
    unhedgedPositions: rows.reduce((t, r) => t + r.unhedged.count, 0),
    legs: legs.length,
    symbols: rows,
  };
}

export type HedgeSymbolResult = { symbol: string; side: "BUY" | "SELL"; clients: number; lots: string; legTicket: number | null; price: string | null; error: string | null };

/** D8: hedge every unhedged client position of the given symbols (all symbols when none), one leg per symbol and side. */
export async function hedgeBySymbol(brokerId: string, adminId: string | null, symbols?: string[]): Promise<HedgeSymbolResult[]> {
  const coverage = await ensureCoverageAccount(brokerId, adminId);
  const open = (await clientPositions(brokerId, coverage.accountId, symbols)).filter((p) => !p.covered);
  const groups = new Map<string, Pos[]>();
  for (const p of open) groups.set(`${p.symbol.name}\u0000${p.side}`, [...(groups.get(`${p.symbol.name}\u0000${p.side}`) ?? []), p]);
  const results: HedgeSymbolResult[] = [];
  for (const [key, ps] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [symbol, side] = key.split("\u0000") as [string, "BUY" | "SELL"];
    const live = await getFreshPrice(symbol);
    if (!live) {
      results.push({ symbol, side, clients: ps.length, lots: lots(ps.reduce((t, p) => t.add(p.volume), D0())), legTicket: null, price: null, error: "no live price" });
      continue;
    }
    // the raw market, no markup and no commission (a hedge-account fill), as BOOK NOW fills
    const fillPrice = side === "BUY" ? live.ask : live.bid;
    const made = await prisma.$transaction(async (tx) => {
      // lock the clients and keep only those still open and unhedged: two Hedge clicks never hedge a position twice
      const ids = ps.map((p) => p.id);
      const fresh = await tx.$queryRaw<{ id: string; volume: Prisma.Decimal }[]>`
        SELECT id, volume FROM "Position" WHERE id = ANY(${ids}) AND status = 'OPEN' AND covered = false FOR UPDATE`;
      if (fresh.length === 0) return null;
      const volume = fresh.reduce((t, r) => t.add(new Prisma.Decimal(r.volume)), D0());
      const symbolId = ps[0].symbolId;
      const now = new Date();
      const order = await tx.order.create({
        data: {
          brokerId, accountId: coverage.accountId, symbolId, side, type: "MARKET", volume, requestedPrice: fillPrice,
          idempotencyKey: `coverage_symbol_${randomUUID()}`, status: "FILLED", source: "ADMIN", filledPrice: fillPrice, filledAt: now,
          executedAt: now, executionMode: "DEALER", platform: "Backoffice", routing: "LP",
        },
      });
      const leg = await tx.position.create({
        data: { brokerId, accountId: coverage.accountId, symbolId, originOrderId: order.id, side, volume, openPrice: fillPrice, bookType: "A_BOOK" },
      });
      await writeOpenDealInTx(tx, { positionId: leg.id, reason: "COVERAGE", adminId });
      const freshIds = fresh.map((r) => r.id);
      await tx.position.updateMany({ where: { id: { in: freshIds } }, data: { covered: true, coveredAt: now, coveragePositionId: leg.id } });
      const byId = new Map(ps.map((p) => [p.id, p]));
      await tx.auditLog.createMany({
        data: freshIds.map((id) => ({
          brokerId, actorAdminId: adminId, action: "POSITION_COVERAGE_BOOKED", entityType: "Position", entityId: id,
          newValue: {
            clientPositionId: id, clientTicket: byId.get(id)!.ticket, coveragePositionId: leg.id, coverageTicket: leg.ticket, coverageAccountId: coverage.accountId,
            symbol, side, volume: byId.get(id)!.volume.toString(), bookPrice: fillPrice.toString(), sharedLeg: { lots: volume.toString(), clients: freshIds.length },
          },
        })),
      });
      return { order, leg, volume, clients: freshIds.length };
    });
    if (!made) {
      results.push({ symbol, side, clients: 0, lots: "0.00", legTicket: null, price: null, error: "already hedged" });
      continue;
    }
    await publishTradingEvent("OrderFilled", {
      order_id: made.order.id, account_id: coverage.accountId, broker_id: brokerId, price: fillPrice.toString(), volume: made.volume.toString(), remaining_volume: "0",
    }).catch((err) => console.error("publish coverage OrderFilled failed", err));
    results.push({ symbol, side, clients: made.clients, lots: lots(made.volume), legTicket: made.leg.ticket, price: fillPrice.toString(), error: null });
  }
  return results;
}
