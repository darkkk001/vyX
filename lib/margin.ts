import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";

export type AccountMarginSnapshot = {
  accountId: string;
  accountNumber: string;
  balance: number;
  equity: number;
  usedMargin: number;
  exposure: number;
  positionCount: number;
  marginCallLevel: number;
  stopOutLevel: number;
  marginLevel: number | null; // null = no used margin (no fresh price for any open position)
};

// Shared by the Risk Dashboard stats (app/manage/(shell)/risk/page.tsx),
// the Risk report CSV (app/api/manage/reports/risk/route.ts), and the
// Margin monitoring page (app/manage/(shell)/margin/page.tsx) -- was
// duplicated across the first two in Phase A, factored out here rather
// than adding a third copy. Margin level = equity / usedMargin * 100,
// same formula components/webtrader/WebTrader.tsx's client-side
// marginLevel already uses, computed broker-wide here instead of for one
// logged-in trader.
export async function computeAccountMarginSnapshots(prisma: PrismaClient, brokerId: string): Promise<AccountMarginSnapshot[]> {
  const positions = await prisma.position.findMany({
    where: { brokerId, status: "OPEN" },
    include: {
      account: {
        select: { id: true, accountNumber: true, balance: true, leverage: true, group: { select: { marginCallLevel: true, stopOutLevel: true } } },
      },
      symbol: { select: { name: true, contractSize: true } },
    },
  });

  const priceBySymbol = await getFreshPrices([...new Set(positions.map((p) => p.symbol.name))]);

  const byAccount = new Map<string, AccountMarginSnapshot>();
  for (const p of positions) {
    const snap = byAccount.get(p.account.id) ?? {
      accountId: p.account.id,
      accountNumber: p.account.accountNumber,
      balance: p.account.balance.toNumber(),
      equity: p.account.balance.toNumber(),
      usedMargin: 0,
      exposure: 0,
      positionCount: 0,
      marginCallLevel: p.account.group?.marginCallLevel.toNumber() ?? 100,
      stopOutLevel: p.account.group?.stopOutLevel.toNumber() ?? 50,
      marginLevel: null,
    };
    snap.exposure += p.volume.toNumber();
    snap.positionCount += 1;

    const live = priceBySymbol.get(p.symbol.name);
    if (live) {
      const currentPrice = p.side === "BUY" ? live.bid : live.ask;
      snap.equity += computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: currentPrice, volume: p.volume, contractSize: p.symbol.contractSize }).toNumber();
      snap.usedMargin += p.symbol.contractSize.toNumber() * p.volume.toNumber() * live.bid.toNumber() / p.account.leverage;
    }

    byAccount.set(p.account.id, snap);
  }

  for (const snap of byAccount.values()) {
    snap.marginLevel = snap.usedMargin > 0 ? (snap.equity / snap.usedMargin) * 100 : null;
  }

  return [...byAccount.values()];
}

// Phase 0 money-risk patch (docs/ROADMAP.md item 2) -- standard forex
// margin formula, kept identical to engine/risk/src/lib.rs's own
// required_margin (volume * contract_size * price / leverage) so both
// paths agree on what a position costs in margin. See
// lib/margin.test.ts's parity test against that crate's own
// required_margin_standard_lot_1_to_100 fixture.
export function requiredMarginFor(
  volume: Prisma.Decimal,
  contractSize: Prisma.Decimal,
  price: Prisma.Decimal,
  leverage: number
): Prisma.Decimal {
  return volume.mul(contractSize).mul(price).div(leverage);
}

// Same "would this order push the account below its margin-call level"
// gate as engine/risk/src/lib.rs's check_free_margin -- at
// marginCallLevel=100 (Group.marginCallLevel's own default) this reduces
// to that function's exact free-margin >= required-margin inequality
// (see lib/margin.test.ts). Generalized to an account's own configured
// call level rather than Rust's hardcoded 100, matching the rest of this
// app's convention of group-configurable thresholds (Group.marginCallLevel,
// already read by computeAccountMarginSnapshots above). null = safe to open.
export function checkPreTradeMargin(params: {
  equity: Prisma.Decimal;
  usedMargin: Prisma.Decimal;
  requiredMargin: Prisma.Decimal;
  marginCallLevel: Prisma.Decimal;
}): string | null {
  const projectedUsedMargin = params.usedMargin.add(params.requiredMargin);
  if (projectedUsedMargin.isZero()) return null;
  const projectedLevel = params.equity.div(projectedUsedMargin).mul(100);
  if (projectedLevel.lt(params.marginCallLevel)) {
    return "INSUFFICIENT_MARGIN";
  }
  return null;
}

export type PreTradeMarginRejection = { error: string; required: string; available: string };

// DB-touching wrapper around checkPreTradeMargin above -- computes this
// one account's current equity/used-margin (same per-position formulas
// computeAccountMarginSnapshots uses broker-wide) and evaluates a new
// order about to open at fillPrice against it. Called by every route
// that's about to open a Position for real: app/api/trade/orders/route.ts
// (both the immediate-fill and Smart-Dealer-auto-accept branches) and
// .../orders/[id]/fill/route.ts (a triggered LIMIT/STOP order) -- the
// same two places lib/risk.ts's checkPriceFreshness/checkSlippage
// landed, closing the parallel "no pre-trade check at all" gap for
// margin instead of price. On reject, returns the actual numbers (not
// just a bare code) so the client can show a real "insufficient margin —
// required $X, available $Y" message instead of a bare rejection.
export async function checkAccountPreTradeMargin(
  prisma: PrismaClient,
  params: {
    accountId: string;
    leverage: number;
    marginCallLevel: Prisma.Decimal;
    newOrderContractSize: Prisma.Decimal;
    newOrderVolume: Prisma.Decimal;
    newOrderFillPrice: Prisma.Decimal;
  }
): Promise<PreTradeMarginRejection | null> {
  const [account, positions] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: params.accountId }, select: { balance: true } }),
    prisma.position.findMany({
      where: { accountId: params.accountId, status: "OPEN" },
      select: { side: true, volume: true, openPrice: true, symbol: { select: { name: true, contractSize: true } } },
    }),
  ]);

  const priceBySymbol = await getFreshPrices([...new Set(positions.map((p) => p.symbol.name))]);

  let equity = account.balance;
  let usedMargin = new Prisma.Decimal(0);
  for (const p of positions) {
    usedMargin = usedMargin.add(requiredMarginFor(p.volume, p.symbol.contractSize, p.openPrice, params.leverage));
    const live = priceBySymbol.get(p.symbol.name);
    if (live) {
      const currentPrice = p.side === "BUY" ? live.bid : live.ask;
      equity = equity.add(
        computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: currentPrice, volume: p.volume, contractSize: p.symbol.contractSize })
      );
    }
  }

  const requiredMargin = requiredMarginFor(params.newOrderVolume, params.newOrderContractSize, params.newOrderFillPrice, params.leverage);
  const rejectCode = checkPreTradeMargin({ equity, usedMargin, requiredMargin, marginCallLevel: params.marginCallLevel });
  if (!rejectCode) return null;
  return { error: rejectCode, required: requiredMargin.toFixed(2), available: equity.sub(usedMargin).toFixed(2) };
}
