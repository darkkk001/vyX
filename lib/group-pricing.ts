import { Prisma, RoutingCategory, BookType } from "@prisma/client";
import type { OrderSide } from "@/lib/trading";
import { lockAccountBalance } from "@/lib/account-lock";
import { negativeMarkupEnabled } from "@/lib/negative-markup-flag";

type Tx = Prisma.TransactionClient;

// See RoutingCategory's own schema comment. Takes the ROUTING axis and
// only that -- an account's mode (LIVE/DEMO) never reaches here, because
// where the risk goes is not a function of whose money it is. Ungrouped
// accounts never call this -- callers fall back to
// BrokerSymbol.defaultBookType directly instead, unchanged from before
// this feature existed.
//
// Stage 1 of docs/ACCOUNT-STRUCTURE-MIGRATION.md changed this function's
// INPUT, not its output: A_BOOK/COVERAGE book A exactly as LP/COVERAGE did
// before, and every other category books B exactly as DEALING/DEMO did.
// Every existing row maps to the same BookType it did before the
// migration -- that equivalence is asserted in lib/group-pricing.test.ts.
export function resolveBookType(category: RoutingCategory): BookType {
  // A_BOOK bridges to a real liquidity provider; COVERAGE is the broker's
  // own B-book hedge account (the offsetting leg of a booked client
  // position) -- both are real market-facing exposure, so both book
  // A_BOOK. B_BOOK / DEALING / REVERSAL all stay in the broker's own book.
  return category === "A_BOOK" || category === "COVERAGE" ? "A_BOOK" : "B_BOOK";
}

// 1 pip in price units for a symbol with this many decimal digits -- same
// convention (and the same formula) as engine/order-management/src/
// pricing.rs's own pip_size, kept in sync deliberately so a symbol's pip
// size means the same thing regardless of which system quotes it.
export function pipSize(digits: number): Prisma.Decimal {
  const exp = Math.max(digits - 1, 0);
  return new Prisma.Decimal(1).div(new Prisma.Decimal(10).pow(exp));
}

// The split of a markup between the two sides (owner decision 2026-11-06, replaces rounding each half outward). The markup
// is counted in whole points of the symbol's last digit, rounded up only if it is not already whole, and the ask takes the
// larger share: 1 point = ask +1, bid +0; 2 = +1, +1; 3 = +2, +1. The total the client pays is exactly the markup. Rounding
// each half outward made a 0.1-pip markup on a 5-digit symbol cost 0.2.
export function markupSplit(markupPips: Prisma.Decimal.Value, digits: number): { ask: Prisma.Decimal; bid: Prisma.Decimal } {
  const point = new Prisma.Decimal(1).div(new Prisma.Decimal(10).pow(Math.max(digits, 0)));
  const total = new Prisma.Decimal(markupPips).mul(pipSize(digits)).div(point).ceil();
  const askPoints = total.div(2).ceil();
  return { ask: askPoints.mul(point), bid: total.sub(askPoints).mul(point) };
}

// NEGATIVE markup (owner 2026-11-09, raw / zero-spread groups). The same whole-point split as above, read with a negative
// total: the spread narrows by exactly the markup (raw 15 points + -13 = 2: the ask comes down 6, the bid goes up 7). When the
// narrowed spread would be 0 or crossed, the client spread FLOORS AT 0: bid = ask = the raw mid at the symbol's precision,
// ROUND HALF TO EVEN (owner decision 2026-11-09). Rounding stays the broker's way on each side (ask up, bid down), the bid is
// never at or below zero. Only ever called for a markup below 0: a markup >= 0 never reaches this (output unchanged).
export function negativeMarkupQuote(markupPips: Prisma.Decimal.Value, digits: number, bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value): { bid: Prisma.Decimal; ask: Prisma.Decimal } {
  const rawBid = new Prisma.Decimal(bid), rawAsk = new Prisma.Decimal(ask);
  const split = markupSplit(markupPips, digits);   // both parts <= 0 for a negative markup
  const point = new Prisma.Decimal(1).div(new Prisma.Decimal(10).pow(Math.max(digits, 0)));
  const a = rawAsk.add(split.ask).toDecimalPlaces(digits, Prisma.Decimal.ROUND_CEIL);
  const b = rawBid.sub(split.bid).toDecimalPlaces(digits, Prisma.Decimal.ROUND_FLOOR);
  if (b.lt(a)) return { bid: Prisma.Decimal.max(b, point), ask: a };
  const mid = Prisma.Decimal.max(rawBid.add(rawAsk).div(2).toDecimalPlaces(digits, Prisma.Decimal.ROUND_HALF_EVEN), point);
  return { bid: mid, ask: mid };
}

/** True only for a markup below zero (a raw / zero-spread group) while NEGATIVE_MARKUP_ENABLED is on (lib/negative-markup-flag.ts); 0, every positive
 *  markup, and any negative value while the flag is off are false: the price then takes the pre-feature path (clamped to raw, never tighter). */
export function isNegativeMarkup(markupPips: Prisma.Decimal.Value): boolean {
  return new Prisma.Decimal(markupPips).lt(0) && negativeMarkupEnabled();
}

// Moves a fill price by its side's share of the markup, away from the client. `side` is the side of the BOOK this price sits
// on, which is what each call site already passes: an ask-side fill (a BUY open, a SELL close) goes up, a bid-side fill (a
// SELL open, a BUY close) goes down.
//
// Same formula as pricing.rs's own apply_spread_markup, applied to whatever price is actually used to fill
// (client-supplied, dealer-typed, or a live tick -- this app's trading routes don't yet have a single point where
// every fill price already comes from a server-owned bid/ask, so this runs as a final adjustment at each fill site
// instead of inside price quoting itself, see app/api/trade/orders/route.ts's own module comment on why the server
// isn't yet the price authority for every path).
//
// Never returns a price at or below zero: a markup wider than the price itself degrades to the smallest quotable
// price rather than going negative (the 60-pip hedge group on a cheap symbol).
//
// A NEGATIVE markup (2026-11-09) needs the other side of the same tick (`opposite`: the raw bid for a BUY-side fill, the raw
// ask for a SELL-side one) to apply negativeMarkupQuote, so the fill equals the quote (lib/ask-markup.ts). A fill with no
// opposite side (a dealer-typed, requoted or no-tick price) keeps the price as given: never narrower than what was typed.
export function applySpreadMarkup(params: {
  side: OrderSide;
  price: Prisma.Decimal | number | string;
  spreadMarkup: Prisma.Decimal | number | string;
  digits: number;
  opposite?: Prisma.Decimal | number | string | null;
}): Prisma.Decimal {
  const price = new Prisma.Decimal(params.price);
  if (isNegativeMarkup(params.spreadMarkup)) {
    if (params.opposite == null) return price;
    const q = params.side === "SELL"
      ? negativeMarkupQuote(params.spreadMarkup, params.digits, price, params.opposite)
      : negativeMarkupQuote(params.spreadMarkup, params.digits, params.opposite, price);
    return params.side === "SELL" ? q.bid : q.ask;
  }
  const split = markupSplit(params.spreadMarkup, params.digits);
  if (params.side === "SELL") {
    if (split.bid.isZero()) return price;
    const floor = new Prisma.Decimal(1).div(new Prisma.Decimal(10).pow(Math.max(params.digits, 0)));
    const out = price.sub(split.bid).toDecimalPlaces(params.digits, Prisma.Decimal.ROUND_FLOOR);
    return Prisma.Decimal.min(Prisma.Decimal.max(out, floor), price);
  }
  if (split.ask.isZero()) return price;
  return Prisma.Decimal.max(price.add(split.ask).toDecimalPlaces(params.digits, Prisma.Decimal.ROUND_CEIL), price);
}

export type ResolvedSymbolPricing = { spreadMarkup: Prisma.Decimal; commissionPerLot: Prisma.Decimal };

// GroupSymbolConfig (if the account has a group AND that group has a row
// for this symbol) overrides BrokerSymbol's broker-wide value -- same
// "missing config = defaults" convention BrokerSymbol itself uses against
// Symbol. See GroupSymbolConfig's own schema comment.
export async function resolveSymbolPricing(
  tx: Tx,
  params: { groupId: string | null | undefined; symbolId: string; brokerSpreadMarkup: Prisma.Decimal; brokerCommissionPerLot: Prisma.Decimal }
): Promise<ResolvedSymbolPricing> {
  if (!params.groupId) {
    return { spreadMarkup: params.brokerSpreadMarkup, commissionPerLot: params.brokerCommissionPerLot };
  }
  // 2026-09-07 outage fix -- explicit select, deliberately WITHOUT
  // targetTotalSpreadPips (a pricing-engine-only column this function
  // never reads -- see the per-field fallback comment below, this
  // function predates that field entirely). An implicit "select every
  // column" here coupled every grouped account's FILL -- not just its
  // price display -- to a column that didn't exist yet in every
  // database the moment it was added to schema.prisma, well before its
  // migration had actually run everywhere; this is the exact same class
  // of bug that took /api/trade/prices down, just on the money path
  // instead of the display path.
  const override = await tx.groupSymbolConfig.findUnique({
    where: { groupId_symbolId: { groupId: params.groupId, symbolId: params.symbolId } },
    select: { spreadMarkup: true, commissionPerLot: true },
  });
  if (!override) {
    return { spreadMarkup: params.brokerSpreadMarkup, commissionPerLot: params.brokerCommissionPerLot };
  }
  // Per-field fallback (2026-09-07 migration pricing_engine_nullable_widening
  // made these columns nullable) -- a row existing here no longer forces
  // BOTH fields, only whichever ones it actually sets; a null field falls
  // through to the broker-wide default exactly like no row at all. No
  // existing row has ever stored null (this function predates the
  // migration), so this is a no-op for every row that exists today.
  return {
    spreadMarkup: override.spreadMarkup ?? params.brokerSpreadMarkup,
    commissionPerLot: override.commissionPerLot ?? params.brokerCommissionPerLot,
  };
}

// Charges commissionPerLot * volume against the account's balance as a
// real ledger Transaction, same balanceBefore/balanceAfter shape every
// other balance-changing flow in this app uses (see
// app/api/manage/positions/[id]/close/route.ts's own TRADE_PNL
// Transaction for the pattern this mirrors). A zero commission (the
// default for every symbol/group until a broker sets one) creates no
// Transaction row at all -- same "skip the no-op write" convention
// app/api/manage/accounts/route.ts's own initial-balance Transaction
// uses (`if (initialBalance.gt(0))`).
export async function chargeCommission(
  tx: Tx,
  params: { brokerId: string; accountId: string; positionId: string; commissionPerLot: Prisma.Decimal; volume: Prisma.Decimal }
): Promise<Prisma.Decimal | null> {
  // returns the balance after the charge (the row is locked, so it is exact), or null when nothing was charged
  const amount = params.commissionPerLot.mul(params.volume);
  if (amount.lte(0)) return null;

  const balanceBefore = await lockAccountBalance(tx, params.accountId); // row lock: lib/account-lock.ts
  const balanceAfter = balanceBefore.sub(amount);

  await tx.account.update({ where: { id: params.accountId }, data: { balance: balanceAfter } });
  await tx.transaction.create({
    data: {
      brokerId: params.brokerId,
      accountId: params.accountId,
      type: "COMMISSION",
      status: "COMPLETED",
      amount: amount.neg(),
      balanceBefore,
      balanceAfter,
      referenceType: "Position",
      referenceId: params.positionId,
      note: `Commission: ${params.volume} lots @ ${params.commissionPerLot}/lot`,
    },
  });

  // The position carries the charge too, not just the ledger. Without this the
  // money left the balance and Position.commission stayed at its 0 default, so
  // every reader of that column reported nothing had been charged:
  //   lib/commission.ts (IB PERCENTAGE payout = rate x SUM(commission)) paid 0,
  //   manage/reports/summary and reports/trading showed 0 revenue,
  //   manage/positions and the deals screens showed 0,
  //   and WebTrader showed 0.00 on a position whose balance HAD been debited.
  // The Rust engine's own path already does this (order-management/db.rs:334);
  // this is the TypeScript path catching up. See docs/WRONG-FIELD-AUDIT §2.1.
  //
  // increment, not set: a position can be charged more than once in principle
  // (the column is cumulative, same as the ledger), and increment is also
  // safe against a retry landing twice as a set would not be.
  await tx.position.update({
    where: { id: params.positionId },
    data: { commission: { increment: amount } },
  });
  return balanceAfter;
}
