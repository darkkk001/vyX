import { Prisma, PrismaClient, TradingMode, SymbolCategory } from "@prisma/client";
import type { OrderSide } from "@/lib/trading";
import { pipSize } from "@/lib/group-pricing";
import { getLivePriceRow } from "@/lib/live-price";
import { isWeeklyClosed, nextWeeklyReopen, nyCloseHourUtc } from "@/lib/market-week";

type Db = PrismaClient | Prisma.TransactionClient;

// Broker-wide emergency halt -- see Broker.tradingHaltedAt's own schema
// comment. Existing open positions are untouched; this only blocks new
// orders/positions.
export function checkTradingHalted(broker: { tradingHaltedAt: Date | null }): string | null {
  if (broker.tradingHaltedAt) return "trading is halted for this broker";
  return null;
}

// Broker-wide close-only mode -- see Broker.closeOnlyAt's own schema
// comment. Only ever checked on the OPEN side (new orders/positions);
// there is no equivalent gate on position close/modify routes, since
// letting existing exposure be closed down is exactly what this mode is
// for. If tradingHaltedAt is also set, checkTradingHalted already
// blocks everything first -- callers run both checks (this one second),
// so a fully-halted broker never reaches this one, and close-only alone
// blocks opens without needing tradingHaltedAt involved at all.
export function checkCloseOnly(broker: { closeOnlyAt: Date | null }): string | null {
  if (broker.closeOnlyAt) return "close-only mode is active for this broker: only closing existing positions is allowed";
  return null;
}

// Per-group full halt -- see Group.tradingHaltedAt's own schema comment.
// Group.tradingRestriction (checkGroupTradingRestriction below) can only
// narrow to one side; this is the "stop this group entirely" gate
// TradingMode has no value for, scoped to one group rather than the
// whole broker like checkTradingHalted.
export function checkGroupTradingHalted(group: { tradingHaltedAt: Date | null }): string | null {
  if (group.tradingHaltedAt) return "trading is halted for this account's group";
  return null;
}

// Per-group close-only -- see Group.closeOnlyAt's own schema comment. The
// per-group twin of checkCloseOnly above: opening is refused for this group
// only, closing an existing position is still allowed. Checked beside
// checkGroupTradingHalted at every order-open gate; a group with both set is
// simply halted (the stronger gate returns first), same as the broker pair.
export function checkGroupCloseOnly(group: { closeOnlyAt: Date | null }): string | null {
  if (group.closeOnlyAt) return "close-only mode is active for this account's group: only closing existing positions is allowed";
  return null;
}

// Account status at every OPEN gate (2026-09-29, split out of the held trading-rights batch, owner decision): the
// order routes never looked at Account.status, so a client signed in before a suspension could keep opening. A
// SUSPENDED / CLOSED account now opens nothing (placement, pending trigger, requote accept, dealer accept, desk flush,
// staff manual open, copy-rule open, reverse); its sessions are also revoked when it is suspended
// (app/api/manage/accounts/[id]/route.ts). Closing and the automatic closes are unaffected: risk must still unwind.
export function checkAccountStatusForOpen(account: { status: "ACTIVE" | "SUSPENDED" | "CLOSED" }): string | null {
  if (account.status === "SUSPENDED") return "this account is suspended";
  if (account.status === "CLOSED") return "this account is closed";
  return null;
}

// Per-account trading rights + account status (2026-09-28, owner decisions). One check for every trader- or
// staff-initiated action on a client account, by intent:
//   open   -- a new position or an order that can open one (placement, pending trigger, requote accept, dealer accept,
//             desk flush, admin manual open, copy-rule open, reverse). Refused unless the account is ACTIVE and FULL.
//   close  -- the client's own close / close-by / bulk close. Refused only when READ_ONLY.
//   modify -- the client's own SL/TP change, pending-order change or cancel. Refused only when READ_ONLY.
// Staff closes and SL/TP changes (the desk managing risk) and the automatic actions (SL/TP triggers, stop-out, margin
// call, swap) never call this. A SUSPENDED / CLOSED account is refused on open (the status hole found 2026-09-28:
// the order routes never looked at status); its sessions are also revoked when it is suspended.
export type TradeIntent = "open" | "close" | "modify";
export const TRADING_RIGHTS_CLOSE_ONLY_MESSAGE = "Your account is close-only: you can close positions but not open new ones";
export const TRADING_RIGHTS_READ_ONLY_MESSAGE = "Your account is read-only: trading is disabled";
export function checkAccountTradingRights(
  account: { status: "ACTIVE" | "SUSPENDED" | "CLOSED"; tradingRights: "FULL" | "CLOSE_ONLY" | "READ_ONLY" },
  intent: TradeIntent
): string | null {
  if (intent === "open") {
    const status = checkAccountStatusForOpen(account);
    if (status) return status;
    if (account.tradingRights === "READ_ONLY") return TRADING_RIGHTS_READ_ONLY_MESSAGE;
    if (account.tradingRights === "CLOSE_ONLY") return TRADING_RIGHTS_CLOSE_ONLY_MESSAGE;
    return null;
  }
  if (account.tradingRights === "READ_ONLY") return TRADING_RIGHTS_READ_ONLY_MESSAGE;
  return null;
}

// BOTH (default) never blocks. BUY_ONLY/SELL_ONLY reject the disallowed
// side even when the symbol is otherwise enabled -- a stronger
// restriction than `enabled`, not a replacement for it.
export function checkSymbolTradingMode(tradingMode: TradingMode, side: OrderSide): string | null {
  if (tradingMode === "BUY_ONLY" && side !== "BUY") return "this symbol is buy-only right now";
  if (tradingMode === "SELL_ONLY" && side !== "SELL") return "this symbol is sell-only right now";
  return null;
}

// Null = no override, falls through to the existing per-symbol
// minLot/maxLot check unchanged (that one lives inline in each order
// route, not here). Group.maxLotSize is a per-order cap, not cumulative.
export function checkGroupMaxLot(volume: Prisma.Decimal, groupMaxLot: Prisma.Decimal | null): string | null {
  if (groupMaxLot == null) return null;
  if (volume.gt(groupMaxLot)) {
    return `volume exceeds this account's group max lot size of ${groupMaxLot}`;
  }
  return null;
}

// Group minimum volume (owner 2026-10-06). The smallest order an account may place is the larger of the symbol's own
// minimum and its group's minimum (Group.minLotSize, null = none). The symbol minimum keeps its own inline check; this
// one refuses what is above the symbol minimum but below the group's, with code GROUP_MIN_VOLUME (riskCode below).
export const GROUP_MIN_VOLUME = "GROUP_MIN_VOLUME";
const GROUP_MIN_VOLUME_TEXT = "The smallest trade allowed for this account is ";
export function effectiveMinLot(symbolMinLot: Prisma.Decimal, groupMinLot: Prisma.Decimal | null): Prisma.Decimal {
  return groupMinLot != null && groupMinLot.gt(symbolMinLot) ? groupMinLot : symbolMinLot;
}
export function checkGroupMinLot(volume: Prisma.Decimal, groupMinLot: Prisma.Decimal | null, symbolMinLot: Prisma.Decimal): string | null {
  const min = effectiveMinLot(symbolMinLot, groupMinLot);
  if (volume.lt(min)) return `${GROUP_MIN_VOLUME_TEXT}${min.toFixed(2)} lots.`;
  return null;
}
/** The machine-readable code for a risk refusal, when it has one (spread into the JSON error body). */
export function riskCode(error: string): { code: string } | Record<string, never> {
  return error.startsWith(GROUP_MIN_VOLUME_TEXT) ? { code: GROUP_MIN_VOLUME } : error.startsWith("hedging is not allowed") ? { code: "HEDGING_NOT_ALLOWED" } : {};
}

// A group minimum has to sit on each symbol's volume grid (minLot + n x lotStep), or no order could ever meet it
// exactly. Returns the symbols it does not fit; the group save is refused with code MIN_VOLUME_STEP when any do.
export function groupMinOffGrid(groupMinLot: Prisma.Decimal, symbols: { name: string; minLot: Prisma.Decimal; lotStep: Prisma.Decimal }[]): string[] {
  return symbols
    .filter((s) => groupMinLot.gt(s.minLot) && checkLotStep(groupMinLot, s.minLot, s.lotStep) != null)
    .map((s) => s.name);
}

// Same shape/semantics as checkSymbolTradingMode, applied at the
// account's group level instead of the symbol level -- both can block
// independently.
export function checkGroupTradingRestriction(restriction: TradingMode, side: OrderSide): string | null {
  if (restriction === "BUY_ONLY" && side !== "BUY") return "this account's group is buy-only right now";
  if (restriction === "SELL_ONLY" && side !== "SELL") return "this account's group is sell-only right now";
  return null;
}

// Opt-in -- restrictSymbols defaults to false on every group (see
// Group.restrictSymbols's own schema comment), in which case this never
// blocks anything, identical to before this check existed. Only once a
// broker admin explicitly turns it on for a group does that group's
// GroupSymbol rows become an allowlist instead of being ignored.
export function checkGroupAllowedSymbol(
  restrictSymbols: boolean,
  allowedSymbolIds: string[],
  symbolId: string
): string | null {
  if (!restrictSymbols) return null;
  if (!allowedSymbolIds.includes(symbolId)) {
    return "this symbol is not enabled for this account's group";
  }
  return null;
}

// Volume must be minLot plus a whole number of lotStep increments (not
// just within the min/max range, which both live order routes already
// check separately). Decimal math throughout -- never Number/float.
export function checkLotStep(volume: Prisma.Decimal, minLot: Prisma.Decimal, lotStep: Prisma.Decimal): string | null {
  if (lotStep.lte(0)) return null; // misconfigured lotStep -- don't hard-block trading over it
  const remainder = volume.sub(minLot).mod(lotStep);
  if (!remainder.isZero()) {
    return `volume must be ${minLot} plus a multiple of ${lotStep}`;
  }
  return null;
}

// 2026-09-06 fix: this used to be a hardcoded ["BTCUSD", "ETHUSD"]
// allowlist -- correct when those were the only two CRYPTO symbols this
// platform had, wrong the moment SOLUSD/XRPUSD were added to the catalog
// (Symbol.category = CRYPTO) without anyone updating this list. Live
// bug, confirmed on Futurix Global: both are enabled for real trading,
// but a real Sunday-afternoon UTC check (genuinely closed for FX/metals/
// indices) incorrectly reported them MARKET_CLOSED too. Now driven
// directly off Symbol.category -- every CRYPTO-category symbol is always
// tradable, present or future, with nothing to keep in sync by hand on
// this side. engine/market-data/src/gap_fill.rs's own
// is_continuously_traded() has the identical hardcoded-list bug and needs
// the equivalent category-driven fix on its own next Contabo deploy (that
// crate has no live per-symbol category lookup today -- see its own
// comment -- so its fix is a separate, larger change, not a one-line
// mirror of this one).
function isContinuouslyTraded(category: SymbolCategory): boolean {
  return category === "CRYPTO";
}

// ---- daily settlement break (2026-09-18) ----
// The metals (gold / silver / platinum / palladium) take a ~1-hour daily
// settlement break at 17:00 New York, Mon-Thu, exactly as
// engine/market-data/src/gap_fill.rs's has_daily_break / in_daily_break
// model it for candles. Until now only the engine knew: this route saw
// "no ticks for 15 s" during the break and answered NO_LIVE_FEED /
// PRICE_STALE, so a trader placing a gold order at 22:30 UTC was told
// the FEED was down when the MARKET was closed. The anchor is NY 17:00,
// which is 21:00 UTC in summer (EDT) and 22:00 UTC in winter (EST) --
// the same ny_close_hour_utc the engine computes from US DST dates
// (2nd Sunday of March 07:00 UTC -> 1st Sunday of November 06:00 UTC).
// Applies to the DEFAULT rule only: a broker's own configured
// TradingSession rows always win, break included.
// usEasternIsDst / nyCloseHourUtc live in lib/market-week.ts (the one weekly rule), re-exported here for existing callers
export { usEasternIsDst, nyCloseHourUtc } from "@/lib/market-week";
export function hasDailyBreak(category: SymbolCategory): boolean {
  return category === "METALS";
}
export function isInDailyBreak(now: Date, category: SymbolCategory): boolean {
  if (!hasDailyBreak(category)) return false;
  const day = now.getUTCDay();
  return day >= 1 && day <= 4 && now.getUTCHours() === nyCloseHourUtc(now);
}

// The standard global FX/metals weekend close every major venue observes,
// used as the DEFAULT session when a BrokerSymbol has no admin-configured
// TradingSession rows -- see that model's own schema comment ("zero rows
// = always tradable") and this incident: because literally no broker had
// ever configured session rows for any symbol, checkTradingSession below
// was a no-op for the entire platform, and a MARKET order filled XAUUSD
// on a Saturday. "Zero rows = always tradable" was the wrong default for
// a symbol nobody has actively opted OUT of a real market close for.
//
// The rule itself is lib/market-week.ts's isWeeklyClosed (Friday 17:00 -> Sunday 17:00 New York, 21:00 UTC in summer
// and 22:00 UTC in winter), the same rule the engine and the terminal implement against
// docs/contracts/market-week-vectors.json. It used to be a fixed Friday 21:00 / Sunday 22:00 UTC here: one hour wrong
// every week (summer Sunday 21:00-22:00 refused although the market was open; winter Friday 21:00-22:00 open-looking
// in the terminal while this refused it the other way round).
export function isDefaultFxSessionClosed(now: Date): boolean {
  return isWeeklyClosed(now);
}

// `sessions` (admin-configured TradingSession rows) take priority when
// present -- an explicit configuration always wins over the default.
// Zero configured rows now falls through to isDefaultFxSessionClosed
// instead of "always tradable" (see that function's own comment for why).
// `category` is required, not optional, specifically so a caller can't
// forget it and silently get the old always-open behavior back.
//
// Returns the bare machine-readable code "MARKET_CLOSED" (same
// convention as checkPriceFreshness's PRICE_STALE below) rather than a
// sentence -- the client renders its own friendly copy for this specific
// code (see WebTrader.tsx's handleOrderError); every other caller of this
// function (backoffice dealing-queue/positions/mirror routes) is
// staff-facing, where the bare code is precise enough to act on as-is.
export function checkTradingSession(
  sessions: { dayOfWeek: number; openTime: string; closeTime: string }[],
  now: Date,
  category: SymbolCategory
): string | null {
  if (isContinuouslyTraded(category)) return null;

  if (sessions.length === 0) {
    return isDefaultFxSessionClosed(now) || isInDailyBreak(now, category) ? "MARKET_CLOSED" : null;
  }

  const day = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = sessions.some((s) => sessionCovers(s, day, minutes));
  return open ? null : "MARKET_CLOSED";
}

// web3 (issues.md 335/343, owner 2026-09-30): one trading-session row, all times UTC (no DST: a broker who wants a
// New-York-anchored window edits the rows twice a year, as the SYM editor says). dayOfWeek is the day the window
// OPENS (0 = Sunday). openTime is inclusive, closeTime exclusive:
//   close > open   -> same day, e.g. 08:00-17:00
//   close = "24:00"-> to the end of that day (the old "23:59" left the last minute closed)
//   close < open   -> crosses midnight into the next day, e.g. Mon 22:00-02:00 = Mon 22:00 to Tue 02:00
// open = close is refused by the sessions editor route (ambiguous: empty or 24 h).
export function sessionMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
export function sessionCovers(s: { dayOfWeek: number; openTime: string; closeTime: string }, day: number, minutes: number): boolean {
  const open = sessionMinutes(s.openTime);
  const close = sessionMinutes(s.closeTime);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return false; // malformed row: never open
  if (close > open) return s.dayOfWeek === day && minutes >= open && minutes < close;
  if (close < open) return (s.dayOfWeek === day && minutes >= open) || ((s.dayOfWeek + 1) % 7 === day && minutes < close);
  return false;
}

// Companion to checkTradingSession -- when it returns "MARKET_CLOSED",
// this computes exactly when the symbol reopens, for a real "Market
// closed, opens <time>" message instead of the generic, previously-
// hardcoded "opens Sun 22:00 UTC" every symbol showed regardless of its
// own configured sessions (reported live, 2026-09-05: a trader closing a
// position outside trading hours saw "No live feed for this symbol" --
// checkLiveMarketPrice's own generic message, since position close never
// called checkTradingSession at all before this). Same two-branch shape
// as checkTradingSession itself: the default global FX/metals weekend
// rule (zero configured TradingSession rows) always reopens the next
// Sunday 22:00 UTC; a broker with real configured sessions gets the
// actual earliest upcoming slot from them, scanned day by day rather than
// computed algebraically -- multiple sessions per day, and sessions not
// sorted in the DB, make a closed-form formula more error-prone than a
// plain forward scan.
export function computeNextSessionOpen(
  sessions: { dayOfWeek: number; openTime: string; closeTime: string }[],
  now: Date,
  category?: SymbolCategory
): Date {
  if (sessions.length === 0) {
    // a metals daily break reopens at the top of the next hour (18:00 New York)
    if (category && isInDailyBreak(now, category) && !isDefaultFxSessionClosed(now)) {
      const reopen = new Date(now);
      reopen.setUTCMinutes(0, 0, 0);
      reopen.setUTCHours(reopen.getUTCHours() + 1);
      return reopen;
    }
    return nextWeeklyReopen(now); // Sunday 17:00 New York: 21:00 UTC in summer, 22:00 UTC in winter
  }
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  for (let offset = 0; offset <= 7; offset++) {
    const candidateDay = (now.getUTCDay() + offset) % 7;
    const daySessions = sessions
      .filter((s) => s.dayOfWeek === candidateDay)
      .sort((a, b) => toMinutes(a.openTime) - toMinutes(b.openTime));
    for (const s of daySessions) {
      const [h, m] = s.openTime.split(":").map(Number);
      const candidate = new Date(now);
      candidate.setUTCDate(now.getUTCDate() + offset);
      candidate.setUTCHours(h, m, 0, 0);
      if (candidate.getTime() > now.getTime()) return candidate;
    }
  }
  // Unreachable in practice -- checkTradingSession only returns
  // "MARKET_CLOSED" for a non-empty sessions array when NONE of them
  // cover `now`, which means at least one must start within the next 7
  // days (a session's own close-then-reopen cycle can't exceed a week).
  // Falling back to `now` rather than throwing keeps a close/modify
  // attempt from 500'ing over this instead of just showing an
  // approximate reopen time.
  return now;
}

// Null maxOpenPositions = no limit -- Broker.maxOpenPositionsPerAccount
// has existed since migration 20260817000000_exposure_limits but this is
// its first real read on any live path (previously only engine/risk
// read it, and no live route calls the Rust engine -- see
// docs/architecture.md's 2026-08-18 status re-check).
export async function checkMaxOpenPositions(
  db: Db,
  accountId: string,
  maxOpenPositions: number | null
): Promise<string | null> {
  if (maxOpenPositions == null) return null;
  const openCount = await db.position.count({ where: { accountId, status: "OPEN" } });
  if (openCount >= maxOpenPositions) {
    return `account already has the maximum ${maxOpenPositions} open position(s)`;
  }
  return null;
}

// Null maxExposure = no limit -- BrokerSymbol.maxExposure's own schema
// comment: "Max total open volume (lots) an account may hold in this
// symbol at once, summed across all its open positions." First real
// read on any live path, same gap as checkMaxOpenPositions.
export async function checkSymbolExposure(
  db: Db,
  accountId: string,
  symbolId: string,
  orderVolume: Prisma.Decimal,
  maxExposure: Prisma.Decimal | null
): Promise<string | null> {
  if (maxExposure == null) return null;
  const agg = await db.position.aggregate({
    where: { accountId, symbolId, status: "OPEN" },
    _sum: { volume: true },
  });
  const current = agg._sum.volume ?? new Prisma.Decimal(0);
  if (current.add(orderVolume).gt(maxExposure)) {
    return `order would exceed this symbol's max exposure of ${maxExposure} lots for this account`;
  }
  return null;
}

// Null totalExposureLimit = no limit -- sum of open volume across every
// symbol for this broker (not per-account, unlike checkSymbolExposure).
export async function checkBrokerExposure(
  db: Db,
  brokerId: string,
  orderVolume: Prisma.Decimal,
  totalExposureLimit: Prisma.Decimal | null
): Promise<string | null> {
  if (totalExposureLimit == null) return null;
  // Audit 2026-09-24 (money): the broker's own hedge legs (coverage account / COVERAGE groups) are not client exposure;
  // counting them let every hedge eat into the clients' limit. The exposure screen shows this same measure.
  const broker = await db.broker.findUnique({ where: { id: brokerId }, select: { coverageAccountId: true } });
  const agg = await db.position.aggregate({
    where: {
      brokerId,
      status: "OPEN",
      account: { isInternal: false, group: { category: { not: "COVERAGE" } } },
      ...(broker?.coverageAccountId ? { accountId: { not: broker.coverageAccountId } } : {}),
    },
    _sum: { volume: true },
  });
  const current = agg._sum.volume ?? new Prisma.Decimal(0);
  if (current.add(orderVolume).gt(totalExposureLimit)) {
    return `order would exceed this broker's total exposure limit of ${totalExposureLimit} lots`;
  }
  return null;
}

// POST /api/trade/orders already has its own inline, freshness-only
// version of this for MARKET-order open (a live tick must exist for the
// symbol, no check on how close the client's price is to it -- see that
// route's own module comment on why prices are still client-simulated
// for now). Position close and pending-order fill had **no check at
// all** -- the two places that actually realize P&L to the account
// balance, meaning an authenticated trader could close any position (or
// fill any resting order) at literally any price via a direct API call,
// minting arbitrary profit. This is deliberately stricter than the
// open-side check: not just "a live tick exists" but "the requested
// price is within a generous band of it" -- generous because prices here
// are still client-simulated, not a real matching engine, so this is a
// floor against outright fabrication, not a tight spread match.
const LIVE_PRICE_MAX_AGE_MS = 15_000;
const PRICE_DEVIATION_TOLERANCE_PCT = 2;

// Split so POST /api/trade/orders -- which already fetches LivePrice
// itself for the Smart Dealer diffPct calc a few lines later -- can reuse
// that one query instead of a second round-trip. checkLiveMarketPrice
// below is the fetch-it-yourself convenience wrapper for the two callers
// that don't already have a LivePrice row in hand (close, fill).
export function evaluateLiveMarketPrice(
  livePrice: { bid: Prisma.Decimal; ask: Prisma.Decimal; tickAt: Date } | null,
  symbolName: string,
  clientPrice: Prisma.Decimal | string
): string | null {
  // Bare machine code (2026-09-05, was the sentence "no live feed for this
  // symbol") -- close/modify need to tell a genuine feed outage (market
  // OPEN, feed down -- rare) apart from checkTradingSession's MARKET_CLOSED
  // (market normally closed -- routine, e.g. every weekend). Both used to
  // collapse into this one message, so a trader closing a position outside
  // trading hours saw "no live feed" and read it as the system being
  // broken. Callers now check checkTradingSession FIRST; by the time this
  // runs, "closed" has already been ruled out, so this code means what it
  // says -- render a "reconnecting" style message for it, not "closed".
  if (!livePrice || Date.now() - livePrice.tickAt.getTime() > LIVE_PRICE_MAX_AGE_MS) {
    return "NO_LIVE_FEED";
  }
  const price = new Prisma.Decimal(clientPrice);
  const mid = livePrice.bid.add(livePrice.ask).div(2);
  const diffPct = price.sub(mid).abs().div(mid).mul(100);
  if (diffPct.gt(PRICE_DEVIATION_TOLERANCE_PCT)) {
    return `price is too far from the current market price for ${symbolName}`;
  }
  return null;
}

export async function checkLiveMarketPrice(
  db: Db,
  symbolName: string,
  clientPrice: Prisma.Decimal | string
): Promise<string | null> {
  // lib/live-price (S4): the engine's tick when MARKET_DATA_PRICES=vps, else
  // the caller's own client (its transaction) on Neon, as before.
  const livePrice = await getLivePriceRow(symbolName, db);
  return evaluateLiveMarketPrice(livePrice, symbolName, clientPrice);
}

// Phase 0 money-risk patch (docs/ROADMAP.md) -- the server, not the
// client, is now the execution-price authority for MARKET fills (see
// app/api/trade/orders/route.ts and .../orders/[id]/fill/route.ts's
// rewritten module comments). This is a tighter, purpose-built gate than
// evaluateLiveMarketPrice's own 15s/2% sanity check above: 3s is how
// fresh a tick must be to be trusted as *the* fill price, not just
// evidence that a feed exists at all. Returns the bare machine-readable
// code (not a sentence) so the client can branch on it -- see
// components/webtrader/WebTrader.tsx's placeOrder, which shows a
// price-moved retry toast specifically for this code.
const FILL_PRICE_MAX_AGE_MS = 3_000;

// tick timestamp follow-up -- reads LivePrice.tickAt (the real last-tick
// time engine/market-data/src/ingest.rs's resolve_tick_time computes),
// NOT updatedAt. The incident this closes: updatedAt bumps on every row
// write regardless of whether the underlying price actually changed, and
// the MT5 EA's 5s heartbeat resends an unchanged/frozen price forever --
// so a genuinely stale weekend (or mid-week outage) price still looked
// "fresh" by updatedAt's own clock. tickAt only advances when the
// market's own last tick actually does.
export function checkPriceFreshness(livePrice: { tickAt: Date } | null): string | null {
  if (!livePrice || Date.now() - livePrice.tickAt.getTime() > FILL_PRICE_MAX_AGE_MS) {
    return "PRICE_STALE";
  }
  return null;
}

// The client's submitted price is no longer an executable price (see
// above) -- it's the price the client saw when it clicked Buy/Sell/set a
// pending-order trigger, now used only as a tolerance anchor: how far the
// server's own fill price is allowed to have moved from what the client
// expected before the order gets rejected instead of silently filled at a
// worse price. maxSlippagePips is client-supplied, the trader's own choice.
//
// BEHAVIOR CHANGE 2026-09-24 (owner decision): no preference = UNLIMITED, like MT5 market execution. There used
// to be a hardcoded 5-pip fallback here, so every WebTrader order (it never sent one) and every client that sent
// nothing was rejected on a > 5 pip move. Now the trader sets a cap (the native terminal's SLIPPAGE MAX) or gets
// none; the broker's explicit defaultMaxSlippagePips (dealer settings) still applies where a route passes it.
// Money-safe either way: the fill is always the SERVER's price -- this check only ever protects the trader.

// A triggered pending LIMIT/STOP (.../orders/[id]/fill) is not a trader slippage preference: the client reports
// the trigger price it saw, and this tolerance is how far the live price may be from it before the fill is
// refused. Deliberately unchanged by the market-execution default above.
export const PENDING_TRIGGER_MAX_SLIPPAGE_PIPS = "5";
// The same tolerance in points (5 pips = 50 points on every symbol with 1+ digits) -- what the trigger path uses.
export const PENDING_TRIGGER_MAX_SLIPPAGE_POINTS = "50";

// ---- slippage in POINTS (owner 2026-09-30) ----
// A point is 10^-digits (the price's last digit); the older pip is 10^-(digits-1) (lib/group-pricing.ts pipSize, which
// floors at 1 for a 0-digit symbol). So one pip = 10 points for digits >= 1, and 1 point for digits = 0.
export function pointsPerPip(digits: number): number {
  return digits >= 1 ? 10 : 1;
}
/** A trader's maxSlippagePips value ("unlimited" / number / nothing) in points for a symbol with `digits`. */
export function slippagePipsToPoints(v: string | null | undefined, digits: number): string | null {
  if (v == null || v === "" || v === "unlimited") return v ?? null;
  return new Prisma.Decimal(v).mul(pointsPerPip(digits)).toString();
}
/** The broker's cap in points: the points column, else (before the backfill) the old pips column x 10. */
export function brokerSlippageCapPoints(broker: { defaultMaxSlippagePoints?: Prisma.Decimal | null; defaultMaxSlippagePips?: Prisma.Decimal | null }): Prisma.Decimal | null {
  if (broker.defaultMaxSlippagePoints != null) return new Prisma.Decimal(broker.defaultMaxSlippagePoints);
  if (broker.defaultMaxSlippagePips != null) return new Prisma.Decimal(broker.defaultMaxSlippagePips).mul(10);
  return null;
}
/** The request's trader value in points: `maxSlippagePoints` when sent, else `maxSlippagePips` converted. */
export function traderSlippagePoints(body: { maxSlippagePoints?: unknown; maxSlippagePips?: unknown } | null, digits: number): string | null {
  if (body?.maxSlippagePoints != null) return String(body.maxSlippagePoints);
  if (body?.maxSlippagePips != null) return slippagePipsToPoints(String(body.maxSlippagePips), digits);
  return null;
}

// Owner decision (2026-09-26, Phase 2 batch 3): the EFFECTIVE max slippage is the smaller of the trader's own value
// and the broker's cap (Broker.defaultMaxSlippagePips) -- the broker's number is a ceiling a trader can tighten but
// never widen. The trader's "unlimited" (or nothing sent) means "the broker's cap"; no broker cap means the trader's
// own value; neither = no limit (null). Before, any value the trader sent -- "unlimited" included -- displaced the
// broker default entirely, so the broker setting only ever applied to a client that sent nothing.
/** A trader's max-slippage input is "unlimited", nothing, or a plain non-negative number -- anything else is refused
 *  (400) rather than guessed at. */
export function isValidMaxSlippageInput(v: string | null | undefined): boolean {
  return v == null || v === "" || v === "unlimited" || /^\d+(\.\d+)?$/.test(v.trim());
}

export function effectiveMaxSlippagePips(
  traderValue: string | number | null | undefined,
  brokerCap: Prisma.Decimal | null | undefined
): string | null {
  const cap = brokerCap != null ? new Prisma.Decimal(brokerCap) : null;
  let trader: Prisma.Decimal | null = null;
  if (traderValue != null && traderValue !== "unlimited" && traderValue !== "") {
    try {
      trader = new Prisma.Decimal(String(traderValue));
    } catch {
      trader = null;
    }
    if (trader && trader.lt(0)) trader = null;
  }
  if (trader && cap) return Prisma.Decimal.min(trader, cap).toString();
  if (trader) return trader.toString();
  return cap ? cap.toString() : null;
}

export function checkSlippage(params: {
  clientReferencePrice: Prisma.Decimal | string;
  serverFillPrice: Prisma.Decimal;
  maxSlippagePips?: Prisma.Decimal | number | string | null | undefined;
  // owner 2026-09-30: the tolerance in POINTS (10^-digits each); wins over maxSlippagePips when given
  maxSlippagePoints?: Prisma.Decimal | number | string | null | undefined;
  digits: number;
}): string | null {
  if (params.maxSlippagePoints !== undefined) {
    if (params.maxSlippagePoints === "unlimited" || params.maxSlippagePoints == null) return null;
    const tolerance = new Prisma.Decimal(params.maxSlippagePoints).mul(new Prisma.Decimal(10).pow(-params.digits));
    const deviation = params.serverFillPrice.sub(new Prisma.Decimal(params.clientReferencePrice)).abs();
    return deviation.gt(tolerance) ? "SLIPPAGE_EXCEEDED" : null;
  }
  // Explicit client opt-out -- the native terminal's "M" / unlimited SLIPPAGE MAX
  // sends the literal "unlimited": the client accepts any fill price, so never reject.
  // This deliberately does NOT fall back to the broker default (that fallback is only
  // for a client that sent no preference at all).
  if (params.maxSlippagePips === "unlimited") return null;
  if (params.maxSlippagePips == null) return null;
  const maxPips = new Prisma.Decimal(params.maxSlippagePips);
  const tolerance = maxPips.mul(pipSize(params.digits));
  const deviation = params.serverFillPrice.sub(new Prisma.Decimal(params.clientReferencePrice)).abs();
  if (deviation.gt(tolerance)) {
    return "SLIPPAGE_EXCEEDED";
  }
  return null;
}

// Null maxDailyLoss = no limit. Blocks new orders once today's realized
// P&L (SUM of TRADE_PNL Transaction rows since local midnight) is
// already at or below -maxDailyLoss. Existing open positions are
// untouched -- this only blocks new trading for the rest of the day.
// On-the-fly aggregate query, no new ledger/running-total table needed.
export async function checkMaxDailyLoss(
  db: Db,
  accountId: string,
  maxDailyLoss: Prisma.Decimal | null
): Promise<string | null> {
  if (maxDailyLoss == null) return null;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const agg = await db.transaction.aggregate({
    where: { accountId, type: "TRADE_PNL", createdAt: { gte: startOfToday } },
    _sum: { amount: true },
  });
  const realizedToday = agg._sum.amount ?? new Prisma.Decimal(0);
  if (realizedToday.lte(maxDailyLoss.neg())) {
    return `daily loss limit of ${maxDailyLoss} reached for this account, try again tomorrow`;
  }
  return null;
}
