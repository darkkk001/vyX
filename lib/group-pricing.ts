import { Prisma, GroupType, BookType } from "@prisma/client";
import type { OrderSide } from "@/lib/trading";

type Tx = Prisma.TransactionClient;

// See GroupType's own schema comment -- LP hedges a real LP (once one
// exists), everything else stays in the broker's own book. Ungrouped
// accounts never call this -- callers fall back to
// BrokerSymbol.defaultBookType directly instead, unchanged from before
// this feature existed.
export function resolveBookType(groupType: GroupType): BookType {
  return groupType === "LP" ? "A_BOOK" : "B_BOOK";
}

// 1 pip in price units for a symbol with this many decimal digits -- same
// convention (and the same formula) as engine/order-management/src/
// pricing.rs's own pip_size, kept in sync deliberately so a symbol's pip
// size means the same thing regardless of which system quotes it.
export function pipSize(digits: number): Prisma.Decimal {
  const exp = Math.max(digits - 1, 0);
  return new Prisma.Decimal(1).div(new Prisma.Decimal(10).pow(exp));
}

// Widens a BUY fill by spreadMarkup pips; a SELL fill (which fills at
// bid) is unaffected -- same "ask-only markup" broker revenue convention
// as pricing.rs's own apply_spread_markup, applied here to whatever price
// is actually used to fill (client-supplied, dealer-typed, or a live
// tick -- this app's trading routes don't yet have a single point where
// every fill price already comes from a server-owned bid/ask, so this
// runs as a final adjustment at each fill site instead of inside price
// quoting itself, see app/api/trade/orders/route.ts's own module comment
// on why the server isn't yet the price authority for every path).
export function applySpreadMarkup(params: {
  side: OrderSide;
  price: Prisma.Decimal | number | string;
  spreadMarkup: Prisma.Decimal | number | string;
  digits: number;
}): Prisma.Decimal {
  const price = new Prisma.Decimal(params.price);
  const markup = new Prisma.Decimal(params.spreadMarkup);
  if (params.side === "SELL" || markup.isZero()) return price;
  return price.add(markup.mul(pipSize(params.digits)));
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
  const override = await tx.groupSymbolConfig.findUnique({
    where: { groupId_symbolId: { groupId: params.groupId, symbolId: params.symbolId } },
  });
  if (!override) {
    return { spreadMarkup: params.brokerSpreadMarkup, commissionPerLot: params.brokerCommissionPerLot };
  }
  return { spreadMarkup: override.spreadMarkup, commissionPerLot: override.commissionPerLot };
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
): Promise<void> {
  const amount = params.commissionPerLot.mul(params.volume);
  if (amount.lte(0)) return;

  const account = await tx.account.findUniqueOrThrow({ where: { id: params.accountId } });
  const balanceBefore = account.balance;
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
}
