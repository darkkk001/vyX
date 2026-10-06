import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl, closePriceFor } from "@/lib/trading";
import { conversionRate, loadFxLookup } from "@/lib/fx";
import { loadSellAskRules, valuationAsk } from "@/lib/ask-markup";

// Book P/L, defined ONCE (owner 2026-10-06; naming.md / memory "BOOK P/L RULE"). Every screen that shows a Book P/L
// (Dashboard today / week / month, Reports for any range) calls this module, so the same range always gives the same
// number.
//
// Book P/L = the opposite of the clients' trading PROFIT on trades the company actually holds:
//   - only positions whose group was Book (B_BOOK) or Dealing desk (DEALING) WHEN THEY OPENED
//     (Position.groupCategoryAtOpen, stamped by a database trigger; rows from before that column existed fall back to
//     the account's current group until the backfill fills them);
//   - live accounts only, never internal accounts, never the broker's hedge (coverage) account;
//   - never A-book / bridge-routed, reverse-trading or hedge (COVERAGE) groups, and never a position that was itself
//     routed to the market (bookType A_BOOK) whatever its group;
//   - never voided / deleted positions;
//   - commission and swap are NOT part of it: they are revenue lines of their own.
// Money is kept per account currency and never summed across currencies.

export const BOOK_CATEGORIES = ["B_BOOK", "DEALING"] as const;

type Db = PrismaClient | Prisma.TransactionClient;
export type BookScope = { brokerId: string; coverageAccountId: string | null };
export type CurrencyAmount = { currency: string; amount: Prisma.Decimal; count: number };

// The WHERE part every Book P/L query shares (aliases: p = Position, a = Account, g = the account's Group).
function heldSql(s: BookScope) {
  return Prisma.sql`p."brokerId" = ${s.brokerId} AND p."deletedAt" IS NULL
    AND a."accountMode" = 'LIVE' AND a."isInternal" = false
    AND (${s.coverageAccountId}::text IS NULL OR a.id <> ${s.coverageAccountId})
    AND (g.category IS NULL OR g.category <> 'COVERAGE')
    AND COALESCE(p."groupCategoryAtOpen"::text, g.category::text) IN ('B_BOOK', 'DEALING')
    AND p."bookType" = 'B_BOOK'`;
}

/** Realized Book P/L of positions CLOSED in [from, to) (to = null: up to now), per account currency. */
export async function bookPnlRealized(db: Db, s: BookScope, from: Date, to: Date | null = null): Promise<CurrencyAmount[]> {
  const rows = await db.$queryRaw<{ currency: string; total: Prisma.Decimal | null; n: bigint }[]>`
    SELECT a.currency, -SUM(p."realizedPnl") AS total, COUNT(*)::bigint AS n
      FROM "Position" p JOIN "Account" a ON a.id = p."accountId" LEFT JOIN "Group" g ON g.id = a."groupId"
     WHERE ${heldSql(s)} AND p.status = 'CLOSED' AND p."realizedPnl" IS NOT NULL
       AND p."closedAt" >= ${from} AND (${to}::timestamptz IS NULL OR p."closedAt" < ${to})
     GROUP BY a.currency ORDER BY a.currency`;
  return rows.map((r) => ({ currency: r.currency, amount: new Prisma.Decimal(r.total ?? 0), count: Number(r.n) }));
}

/** Floating Book P/L of OPEN positions the company holds, valued like the margin pass values them (a SELL at its
 *  account's ask, quote -> account currency). Positions with no fresh price or no FX rate are counted in `unpriced`
 *  and left out of the amount, never valued as zero. */
export async function bookPnlFloating(db: Db, s: BookScope): Promise<{ byCurrency: CurrencyAmount[]; unpriced: number }> {
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Position" p JOIN "Account" a ON a.id = p."accountId" LEFT JOIN "Group" g ON g.id = a."groupId"
     WHERE ${heldSql(s)} AND p.status = 'OPEN'`;
  if (ids.length === 0) return { byCurrency: [], unpriced: 0 };
  const positions = await db.position.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
    include: {
      account: { select: { id: true, currency: true, groupId: true, brokerId: true } },
      symbol: { select: { name: true, contractSize: true, quoteCurrency: true } },
    },
  });
  const [prices, fx, askRules] = await Promise.all([
    getFreshPrices([...new Set(positions.map((p) => p.symbol.name))]),
    loadFxLookup(db, positions.map((p) => [p.symbol.quoteCurrency, p.account.currency] as const)),
    loadSellAskRules(db, positions),
  ]);
  const byCcy = new Map<string, CurrencyAmount>();
  let unpriced = 0;
  for (const p of positions) {
    const live = prices.get(p.symbol.name);
    const rate = conversionRate(p.symbol.quoteCurrency, p.account.currency, fx);
    if (!live || !rate) { unpriced += 1; continue; }
    const ask = valuationAsk(askRules, p, live.bid, live.ask);
    const now = closePriceFor(p.side, live.bid, ask);
    const clientPnl = computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: now, volume: p.volume, contractSize: p.symbol.contractSize }).mul(rate);
    const row = byCcy.get(p.account.currency) ?? { currency: p.account.currency, amount: new Prisma.Decimal(0), count: 0 };
    row.amount = row.amount.sub(clientPnl); // the broker's side is the client's result reversed
    row.count += 1;
    byCcy.set(p.account.currency, row);
  }
  return { byCurrency: [...byCcy.values()].sort((x, y) => x.currency.localeCompare(y.currency)), unpriced };
}

/** JSON shape shared by the routes. */
export function currencyAmountsJson(rows: CurrencyAmount[]) {
  return rows.map((r) => ({ currency: r.currency, amount: r.amount.toFixed(2), count: r.count }));
}

/** Sum across currencies, ONLY for the legacy single-number fields old backoffice builds read. */
export function legacySum(rows: CurrencyAmount[]): number {
  return rows.reduce((t, r) => t + r.amount.toNumber(), 0);
}
