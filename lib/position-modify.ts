import "server-only";
import { Prisma } from "@prisma/client";
import { accountClosePrice, NO_MARKUP, type AskRule } from "@/lib/ask-markup";
import { checkTradingSession, computeNextSessionOpen } from "@/lib/risk";
import { validateSlTp } from "@/lib/trading";
import { AMOUNT_NO_RATE_TEXT, AMOUNT_NOT_AVAILABLE_TEXT, amountRefusalBody, amountRefusedForAuthority, amountsReachedError } from "@/lib/amount-sltp";
import { conversionRate, loadFxLookup } from "@/lib/fx";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { isDealingManagedAccount, deskIsOn } from "@/lib/dealing-routing";
import { runAfterResponse } from "@/lib/after-response";
import { prisma } from "@/lib/prisma";

// The rules for changing an open position's SL / TP, shared by the single modify (PATCH /api/trade/positions/[id])
// and the bulk modify (POST /api/trade/positions/modify-bulk) so the two can never drift apart.

export type ModifyRefusal = { status: number; body: Record<string, unknown> };

type PositionForModify = { side: "BUY" | "SELL"; status: string; slPrice: Prisma.Decimal | null; tpPrice: Prisma.Decimal | null; symbolId: string; openPrice: Prisma.Decimal; volume: Prisma.Decimal };
type BrokerSymbolForModify = {
  stopLevel: number | null;
  symbol: { digits: number; contractSize: Prisma.Decimal; category: Parameters<typeof checkTradingSession>[2] };
  tradingSessions: Parameters<typeof checkTradingSession>[0];
};

/**
 * Everything that can refuse an SL / TP change on one position, in the order the single route always applied it: open
 * status, market open (with the next-open time), a server live price, then the side-aware SL / TP / stops-level rule
 * against the server's own close-side price. null = allowed. `slPrice` / `tpPrice` undefined = leave that field alone.
 */
export function refuseModify(input: {
  position: PositionForModify;
  brokerSymbol: BrokerSymbolForModify | null;
  symbolName: string | null;
  live: { bid: Prisma.Decimal.Value; ask: Prisma.Decimal.Value } | null;
  askRuleFor: ((symbolId: string) => AskRule | null) | null;
  slPrice: string | null | undefined;
  tpPrice: string | null | undefined;
  // amount SL / TP (lib/amount-sltp.ts) being SET by this change (undefined / null = nothing to check), the quote->account rate (null =
  // unknown) and the account currency; an amount the position has already reached at the server's close-side price is refused
  slAmount?: Prisma.Decimal | null;
  tpAmount?: Prisma.Decimal | null;
  fxRate?: Prisma.Decimal | null;
  accountCurrency?: string;
  now?: Date;
}): ModifyRefusal | null {
  const { position, brokerSymbol, live } = input;
  if (position.status !== "OPEN") return { status: 409, body: { error: "position is not open" } };
  // a level is a plain positive decimal that fits the column, Decimal(18, 5) (security re-audit 2026-10-23): "NaN" /
  // "-Infinity" / "0x10" / " 5" and a 1e308-points TP used to pass the side checks and fail only at the column write
  // (500); "-5" / "0" were stored as levels that never trigger
  for (const [kind, v] of [["SL", input.slPrice], ["TP", input.tpPrice]] as const) {
    if (typeof v === "string" && !(/^\d+(\.\d+)?$/.test(v) && Number(v) > 0 && Number(v) < 1e13)) return { status: 400, body: { error: `${kind} must be a positive price` } };
  }
  const now = input.now ?? new Date();
  const sessions = brokerSymbol?.tradingSessions ?? [];
  const category = brokerSymbol?.symbol.category ?? "FOREX";
  const sessionError = checkTradingSession(sessions, now, category, input.symbolName);
  if (sessionError) return { status: 400, body: { error: sessionError, nextOpenAt: computeNextSessionOpen(sessions, now, category, input.symbolName).toISOString() } };
  // what the position closes / triggers at -- symmetric markup (lib/ask-markup.ts): a BUY at its account's BID,
  // a SELL at its account's ask
  const serverClosePrice = brokerSymbol && live ? accountClosePrice(position.side, live.bid, live.ask, input.askRuleFor?.(position.symbolId) ?? NO_MARKUP).toString() : null;
  if (!serverClosePrice) {
    // no server price at all right now: refuse rather than trust the client's number
    return { status: 400, body: { error: "NO_LIVE_FEED", symbol: input.symbolName } };
  }
  const validationError = validateSlTp({
    side: position.side,
    referencePrice: serverClosePrice,
    slPrice: input.slPrice === undefined ? position.slPrice : input.slPrice,
    tpPrice: input.tpPrice === undefined ? position.tpPrice : input.tpPrice,
    digits: brokerSymbol?.symbol.digits,
    stopLevel: brokerSymbol?.stopLevel ?? undefined,
  });
  if (validationError) return { status: 400, body: { error: validationError } };
  if (input.slAmount != null || input.tpAmount != null) {
    if (!input.fxRate || !brokerSymbol) return { status: 400, body: amountRefusalBody("NO_CONVERSION_RATE", AMOUNT_NO_RATE_TEXT) };
    const reached = amountsReachedError(
      { side: position.side, openPrice: position.openPrice, volume: position.volume, contractSize: brokerSymbol.symbol.contractSize, slAmount: input.slAmount ?? null, tpAmount: input.tpAmount ?? null },
      new Prisma.Decimal(serverClosePrice),
      input.fxRate,
      input.accountCurrency ?? "",
    );
    if (reached) return { status: 400, body: amountRefusalBody("AMOUNT_ALREADY_REACHED", reached) };
  }
  return null;
}

/** What an amount write needs about the account: whether the RUST-authority refusal applies (lib/amount-sltp.ts), the account currency and the
 *  quote->account rate (null = none right now). Read only when a request actually sets an amount, so the price paths pay nothing. */
export async function loadAmountContext(accountId: string, quoteCurrency: string | null): Promise<{ refused: ModifyRefusal | null; currency: string; fxRate: Prisma.Decimal | null }> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { currency: true, accountMode: true, broker: { select: { riskAuthority: true, riskAuthorityDemoOnly: true } } },
  });
  if (amountRefusedForAuthority(account.broker, account.accountMode)) {
    return { refused: { status: 400, body: amountRefusalBody("AMOUNT_SLTP_NOT_AVAILABLE", AMOUNT_NOT_AVAILABLE_TEXT) }, currency: account.currency, fxRate: null };
  }
  let fxRate: Prisma.Decimal | null = null;
  if (quoteCurrency) {
    try {
      fxRate = conversionRate(quoteCurrency, account.currency, await loadFxLookup(prisma, [[quoteCurrency, account.currency]]));
    } catch {
      fxRate = null;
    }
  }
  return { refused: null, currency: account.currency, fxRate };
}

/** The change-event plus the dealer-activity feed row for one modified position (after the response, as the single route did). */
export async function announcePositionModified(input: {
  session: { brokerId: string; accountId: string };
  before: { id: string; accountId: string; side: "BUY" | "SELL"; volume: Prisma.Decimal; slPrice: Prisma.Decimal | null; tpPrice: Prisma.Decimal | null; slAmount?: Prisma.Decimal | null; tpAmount?: Prisma.Decimal | null };
  row: Record<string, unknown>;
  symbolName: string;
  slPrice: string | null | undefined;
  tpPrice: string | null | undefined;
  slAmount?: Prisma.Decimal | null;
  tpAmount?: Prisma.Decimal | null;
}): Promise<void> {
  const { session, before } = input;
  // Latency fix 2 (docs/audit/2026-09-24/latency-contract.md): the updated row in the response AND the event, so the
  // terminal moves the SL/TP line from whichever arrives first.
  await runAfterResponse("publish PositionModified", () =>
    publishTradingEvent("PositionModified", { position_id: before.id, account_id: session.accountId, broker_id: session.brokerId, position: input.row })
  );
  // the dealer-activity feed (backoffice) after the response; its account / broker lookups with it
  await runAfterResponse("modify follow-through", async () => {
    const [account, brokerForActivity] = await Promise.all([
      prisma.account.findUnique({
        where: { id: before.accountId },
        select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true, category: true } } },
      }),
      prisma.broker.findUnique({ where: { id: session.brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } }),
    ]);
    if (!account) return;
    await recordDealerActivity(prisma, {
      brokerId: session.brokerId,
      accountId: session.accountId,
      accountNumber: account.accountNumber,
      accountFullName: account.fullName,
      isDealingGroup: isDealingManagedAccount({ group: account.group, deskOn: deskIsOn(brokerForActivity) }),
      action: "ORDER_MODIFIED",
      symbol: input.symbolName,
      side: before.side,
      volume: before.volume.toString(),
      values: {
        oldSlPrice: before.slPrice?.toString() ?? null,
        newSlPrice: input.slPrice === undefined ? (before.slPrice?.toString() ?? null) : input.slPrice,
        oldTpPrice: before.tpPrice?.toString() ?? null,
        newTpPrice: input.tpPrice === undefined ? (before.tpPrice?.toString() ?? null) : input.tpPrice,
        // amount SL / TP (account currency); only written when the change touches an amount
        ...(input.slAmount !== undefined || before.slAmount != null ? { oldSlAmount: before.slAmount?.toString() ?? null, newSlAmount: input.slAmount === undefined ? (before.slAmount?.toString() ?? null) : input.slAmount?.toString() ?? null } : {}),
        ...(input.tpAmount !== undefined || before.tpAmount != null ? { oldTpAmount: before.tpAmount?.toString() ?? null, newTpAmount: input.tpAmount === undefined ? (before.tpAmount?.toString() ?? null) : input.tpAmount?.toString() ?? null } : {}),
        onOpenPosition: true,
      },
      positionId: before.id,
    });
  });
}

// ---- bulk spec -> per-position prices ----

export type LevelSpec = { price: string } | { points: number | string } | { breakEven: true } | { clear: true } | { amount: Prisma.Decimal };

/** The amount a bulk spec writes for one leg: a Decimal for { amount }, null for anything else that sets or clears the leg (a price replaces an amount,
 *  clear removes the leg), undefined for no spec (leave it). */
export function amountOfSpec(spec: LevelSpec | undefined): Prisma.Decimal | null | undefined {
  if (spec === undefined) return undefined;
  return "amount" in spec ? spec.amount : null;
}

/**
 * One position's new level from a bulk spec. Points are MT5 points (10^-digits) from the position's own entry, the
 * sign worked out per side: BUY SL below / TP above, SELL the reverse. undefined spec = leave the level alone.
 */
export function levelFromSpec(
  kind: "SL" | "TP",
  spec: LevelSpec | undefined,
  position: { side: "BUY" | "SELL"; openPrice: Prisma.Decimal.Value },
  digits: number
): string | null | undefined | { error: string } {
  if (spec === undefined) return undefined;
  if ("clear" in spec) return null;
  if ("amount" in spec) return null; // an amount leg has no price
  if ("price" in spec) {
    const p = String(spec.price).trim();
    if (!p || Number.isNaN(Number(p))) return { error: `${kind} price is not a number` };
    return p;
  }
  const entry = new Prisma.Decimal(position.openPrice);
  if ("breakEven" in spec) {
    if (kind !== "SL") return { error: "break-even applies to the stop loss only" };
    return entry.toFixed(digits);
  }
  const pts = Number(spec.points);
  if (!Number.isFinite(pts) || pts <= 0) return { error: `${kind} points must be a positive number` };
  const distance = new Prisma.Decimal(10).pow(-digits).mul(String(spec.points));
  // SL protects: below a BUY, above a SELL. TP targets: above a BUY, below a SELL.
  const up = (kind === "TP") === (position.side === "BUY");
  return (up ? entry.add(distance) : entry.sub(distance)).toFixed(digits);
}
