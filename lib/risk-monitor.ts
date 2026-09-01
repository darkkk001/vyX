import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";
import { closePositionInTx } from "@/lib/position-close";
import { publishTradingEvent } from "@/lib/nats";
import * as mirror from "@/lib/mirror";

// The legacy Next.js trading path (the one actually carrying every
// broker's live traffic today, per docs/decisions.md ADR-003) has never
// had automatic SL/TP execution or a margin-call/stop-out mechanism --
// confirmed by grep, not assumed: lib/margin.ts's computeAccountMarginSnapshots
// is read-only, feeding the Manager Risk Dashboard/CSV/margin page, and
// takes no action. The Rust engine's engine/order-management/src/monitor.rs
// already does exactly this for whichever broker eventually cuts over to
// it (per ADR-003), but that's a separate, not-yet-cut-over system --
// this module is the legacy path's own equivalent, ported from the same
// design (see monitor.rs's own module doc for the two-pass structure this
// mirrors): first every position whose own SL/TP has been crossed closes,
// independent of margin; then, on whatever remains, if the account's
// margin level is below its group's stopOutLevel, the single worst
// (most negative floating P&L) closeable position is force-closed,
// repeated until back above the threshold or no closeable position is
// left.
//
// Triggered from app/api/internal/price-feed's ingest path (every real
// tick, for every account currently holding an open position in that
// symbol) -- see that route for the call site and docs/market-data.md.

type OpenPositionWithMarket = {
  id: string;
  brokerId: string;
  accountId: string;
  side: "BUY" | "SELL";
  volume: Prisma.Decimal;
  openPrice: Prisma.Decimal;
  slPrice: Prisma.Decimal | null;
  tpPrice: Prisma.Decimal | null;
  contractSize: Prisma.Decimal;
  bid: Prisma.Decimal | null; // null = no fresh (<=15s old) price for this symbol right now
  ask: Prisma.Decimal | null;
};

async function loadOpenPositionsWithMarket(accountId: string): Promise<OpenPositionWithMarket[]> {
  const positions = await prisma.position.findMany({
    where: { accountId, status: "OPEN" },
    include: { symbol: { select: { name: true, contractSize: true } } },
  });
  if (positions.length === 0) return [];

  const prices = await getFreshPrices([...new Set(positions.map((p) => p.symbol.name))]);
  return positions.map((p) => {
    const live = prices.get(p.symbol.name);
    return {
      id: p.id,
      brokerId: p.brokerId,
      accountId: p.accountId,
      side: p.side,
      volume: p.volume,
      openPrice: p.openPrice,
      slPrice: p.slPrice,
      tpPrice: p.tpPrice,
      contractSize: p.symbol.contractSize,
      bid: live?.bid ?? null,
      ask: live?.ask ?? null,
    };
  });
}

// Same convention as monitor.rs's close_price_for and every other close
// price in this app: bid for a BUY, ask for a SELL -- the price closing
// it *now* would actually fill at.
function closePriceFor(side: "BUY" | "SELL", bid: Prisma.Decimal, ask: Prisma.Decimal): Prisma.Decimal {
  return side === "BUY" ? bid : ask;
}

type SlTpReason = "stop_loss" | "take_profit";

function slTpTrigger(p: OpenPositionWithMarket): SlTpReason | null {
  if (p.bid == null || p.ask == null) return null;
  const cp = closePriceFor(p.side, p.bid, p.ask);
  if (p.side === "BUY") {
    if (p.slPrice != null && cp.lte(p.slPrice)) return "stop_loss";
    if (p.tpPrice != null && cp.gte(p.tpPrice)) return "take_profit";
  } else {
    if (p.slPrice != null && cp.gte(p.slPrice)) return "stop_loss";
    if (p.tpPrice != null && cp.lte(p.tpPrice)) return "take_profit";
  }
  return null;
}

export type RiskMonitorResult = {
  evaluated: boolean;
  slTpClosed: string[];
  stopOutClosed: string[];
};

export async function evaluateAccountRisk(accountId: string): Promise<RiskMonitorResult> {
  const slTpClosed: string[] = [];
  const stopOutClosed: string[] = [];

  // Pass 1: SL/TP. Every triggered position closes -- unlike stop-out,
  // this isn't "pick the single worst one," each is an independent
  // trader-chosen exit level, not a margin-driven rescue.
  for (const p of await loadOpenPositionsWithMarket(accountId)) {
    const reason = slTpTrigger(p);
    if (!reason || p.bid == null || p.ask == null) continue;
    const cp = closePriceFor(p.side, p.bid, p.ask);
    const outcome = await prisma.$transaction((tx) =>
      closePositionInTx(tx, {
        position: {
          id: p.id,
          accountId: p.accountId,
          brokerId: p.brokerId,
          side: p.side,
          openPrice: p.openPrice,
          volume: p.volume,
          symbol: { contractSize: p.contractSize },
        },
        closePrice: cp,
        note: reason === "stop_loss" ? "Stop loss hit (automatic)" : "Take profit hit (automatic)",
      })
    );
    if (outcome.closed) {
      slTpClosed.push(p.id);
      // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- mirror hook gap fix: an
      // automatic SL/TP close is a real close, same as a trader's own
      // manual one -- this whole module never called it at all before.
      await mirror.onClose(prisma, { positionId: p.id, brokerId: p.brokerId, closedLots: p.volume, sourceVolumeBeforeClose: p.volume }).catch((err) => console.error("mirror.onClose failed", err));
      await publishTradingEvent("PositionClosed", { position_id: p.id, account_id: accountId, broker_id: p.brokerId, reason });
    }
  }

  // Pass 2: margin / stop-out, on whatever remains open after pass 1.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { group: { select: { stopOutLevel: true } } },
  });
  if (!account) return { evaluated: false, slTpClosed, stopOutClosed };
  const stopOutLevel = account.group?.stopOutLevel ?? new Prisma.Decimal(50);

  for (;;) {
    const positions = (await loadOpenPositionsWithMarket(accountId)).filter(
      (p) => !stopOutClosed.includes(p.id)
    );
    if (positions.length === 0) break;

    // Re-read balance every iteration: it changes after each force-close,
    // and stop-out's whole point is reacting to the account's CURRENT
    // state, not a snapshot from before this loop started.
    const freshAccount = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    let equity = freshAccount.balance;
    let usedMargin = new Prisma.Decimal(0);
    let worst: { position: OpenPositionWithMarket; pnl: Prisma.Decimal; closePrice: Prisma.Decimal } | null = null;

    for (const p of positions) {
      if (p.bid == null || p.ask == null) continue; // no live price -- not closeable, not counted
      const cp = closePriceFor(p.side, p.bid, p.ask);
      const pnl = computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: cp, volume: p.volume, contractSize: p.contractSize });
      equity = equity.add(pnl);
      usedMargin = usedMargin.add(p.contractSize.mul(p.volume).mul(p.bid).div(freshAccount.leverage));
      if (!worst || pnl.lt(worst.pnl)) worst = { position: p, pnl, closePrice: cp };
    }

    if (usedMargin.lte(0)) break; // nothing to gate a margin level on
    const marginLevel = equity.div(usedMargin).mul(100);
    if (marginLevel.gte(stopOutLevel)) break; // back above threshold -- done
    if (!worst) break; // below threshold but nothing closeable has a live price right now -- stuck, not this function's call to guess a price

    const outcome = await prisma.$transaction((tx) =>
      closePositionInTx(tx, {
        position: {
          id: worst!.position.id,
          accountId,
          brokerId: worst!.position.brokerId,
          side: worst!.position.side,
          openPrice: worst!.position.openPrice,
          volume: worst!.position.volume,
          symbol: { contractSize: worst!.position.contractSize },
        },
        closePrice: worst.closePrice,
        note: `Stop-out (automatic): margin level ${marginLevel.toFixed(2)}% below ${stopOutLevel}%`,
      })
    );
    stopOutClosed.push(worst.position.id);
    if (outcome.closed) {
      // docs/briefs/VYX-MIRROR-V0-BRIEF.md -- mirror hook gap fix: an
      // automatic stop-out close is a real close, same as SL/TP above.
      await mirror.onClose(prisma, { positionId: worst.position.id, brokerId: worst.position.brokerId, closedLots: worst.position.volume, sourceVolumeBeforeClose: worst.position.volume }).catch((err) => console.error("mirror.onClose failed", err));
      await publishTradingEvent("PositionClosed", { position_id: worst.position.id, account_id: accountId, broker_id: worst.position.brokerId, reason: "stop_out" });
    }
    // If outcome.closed is false, a concurrent evaluation (or the trader)
    // already closed this exact position first -- it's dropped from
    // consideration above via the stopOutClosed filter either way, so the
    // next loop iteration naturally retries with the next-worst position.
  }

  return { evaluated: true, slTpClosed, stopOutClosed };
}

// Evaluates every account that currently holds an open position in the
// given symbol -- the targeted set a real tick can actually affect,
// rather than sweeping every account on every tick. Called from the
// price-feed ingest route; failures for one account are isolated (a bad
// account never blocks the rest, and never blocks the tick ingest
// response itself from succeeding).
export async function evaluateRiskForSymbol(symbolName: string): Promise<void> {
  const accountIds = await prisma.position.findMany({
    where: { status: "OPEN", symbol: { name: symbolName } },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  for (const { accountId } of accountIds) {
    try {
      await evaluateAccountRisk(accountId);
    } catch (err) {
      console.error("risk-monitor: evaluation failed for account", accountId, err);
    }
  }
}
