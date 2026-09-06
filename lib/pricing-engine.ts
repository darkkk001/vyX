import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// Phase 2 pricing engine (2026-09-07) -- the full per-field precedence
// resolver approved in docs/pricing-engine.md: for spreadMarkup,
// commissionPerLot, swapLong, and swapShort independently,
//
//   AccountSymbolConfig > AccountTypeSymbolConfig > AccountType (flat) >
//   GroupSymbolConfig > BrokerSymbol (base)
//
// and for swapFree (no per-symbol level -- swap-free is an all-symbols
// setting, see AccountType.swapFree's own schema comment):
//
//   Account.swapFree > AccountType.swapFree > Group.swapFree > false
//
// NULL at any level means "not set here, fall through to the next level,"
// never "explicitly zero" -- see GroupSymbolConfig's own schema comment
// for why per-FIELD (not per-row) resolution matters. This is a NEW
// function living alongside lib/group-pricing.ts's existing (group-only)
// resolveSymbolPricing -- nothing calls this yet (see Broker.
// pricingEngineEnabled's own comment); no fill site, and no other caller,
// is wired to it until Stage 4, and even then only for brokers with that
// flag on.
//
// Split into two layers deliberately: resolvePricingV2 is a pure function
// (no DB, no I/O) over already-fetched level values, so every precedence/
// fallthrough path is unit-testable with plain Decimal literals -- see
// lib/pricing-engine.test.ts. resolveSymbolPricingV2 is the thin DB-
// fetching wrapper real callers will eventually use (Stage 4), doing the
// same shape of "fetch once, resolve in memory" every call site in this
// app already does elsewhere.

export type SpreadModeMarkup = { mode: "markup"; spreadMarkup: Prisma.Decimal };
// `fallbackSpreadMarkup` is the SAME level's own spreadMarkup field, when
// that level ALSO set one alongside targetTotalSpreadPips -- 2026-09-07
// decision: the two are no longer mutually exclusive per level. Target
// is the primary intent whenever set (see resolveSpreadAtSymbolLevel),
// and this fallback is what resolveEffectiveSpreadMarkup uses if the live
// base spread is unavailable at fill time (never null -- absence at that
// same level means "no fallback configured," effective markup floors to 0
// instead, not that the trade blocks).
export type SpreadModeTarget = { mode: "target"; targetTotalSpreadPips: Prisma.Decimal; fallbackSpreadMarkup: Prisma.Decimal | null };
export type ResolvedSpread = SpreadModeMarkup | SpreadModeTarget;

export type SpreadWarning =
  | { reason: "target_below_base"; targetTotalSpreadPips: Prisma.Decimal; liveBaseSpreadPips: Prisma.Decimal }
  | { reason: "base_unavailable"; targetTotalSpreadPips: Prisma.Decimal; fallbackMarkupUsed: Prisma.Decimal };

export type EffectiveSpreadResult = { markup: Prisma.Decimal; warning: SpreadWarning | null };

// commissionPerLot/swapLong/swapShort are returned at full Decimal
// precision, deliberately unrounded (2026-09-07 Q4) -- every source
// column across every level is already Decimal(10,2)/(10,4), so this
// resolver has nothing further to round; any rounding of the final
// CHARGE amount (commissionPerLot * volume, which can produce more
// decimal places than commissionPerLot itself) belongs at the ledger/
// charge step (lib/group-pricing.ts's chargeCommission), not here --
// same "resolve first, charge second" split that already exists today.
export type ResolvedPricingV2 = {
  spread: ResolvedSpread;
  commissionPerLot: Prisma.Decimal;
  swapLong: Prisma.Decimal;
  swapShort: Prisma.Decimal;
  swapFree: boolean;
};

// Shape shared by the three per-symbol override tables (AccountSymbolConfig,
// AccountTypeSymbolConfig, GroupSymbolConfig) -- only the fields this
// resolver actually reads, so a real Prisma row satisfies this structurally
// without any mapping at the call site.
export type SymbolConfigLevel = {
  spreadMarkup: Prisma.Decimal | null;
  targetTotalSpreadPips: Prisma.Decimal | null;
  commissionPerLot: Prisma.Decimal | null;
  swapLong: Prisma.Decimal | null;
  swapShort: Prisma.Decimal | null;
} | null;

// AccountType's own flat (type-wide, no per-symbol targetTotalSpreadPips --
// see AccountTypeSymbolConfig's own doc comment for why target mode is
// per-symbol-table only, not on the flat fallback) fields.
export type AccountTypeFlatLevel = {
  spreadMarkup: Prisma.Decimal | null;
  commissionPerLot: Prisma.Decimal | null;
  swapLong: Prisma.Decimal | null;
  swapShort: Prisma.Decimal | null;
  swapFree: boolean | null;
} | null;

export type ResolvePricingV2Params = {
  accountSymbolConfig: SymbolConfigLevel;
  accountTypeSymbolConfig: SymbolConfigLevel;
  accountType: AccountTypeFlatLevel;
  groupSymbolConfig: SymbolConfigLevel;
  brokerSpreadMarkup: Prisma.Decimal;
  brokerCommissionPerLot: Prisma.Decimal;
  brokerSwapLong: Prisma.Decimal;
  brokerSwapShort: Prisma.Decimal;
  accountSwapFree: boolean | null;
  groupSwapFree: boolean | null;
};

function firstNonNull<T>(...candidates: (T | null | undefined)[]): T | null {
  for (const c of candidates) {
    if (c !== null && c !== undefined) return c;
  }
  return null;
}

// A level "sets spread" (and so wins the WHOLE spread decision -- Q2,
// 2026-09-07) if EITHER spreadMarkup or targetTotalSpreadPips is non-null.
// Within that one level, if both are set, targetTotalSpreadPips is the
// broker's primary intent and wins; the level's own spreadMarkup rides
// along as the designated fallback for when the live base spread is
// unavailable at fill time (see resolveEffectiveSpreadMarkup) -- it is
// NOT compared against a lower level's markup, since this level already
// won the decision. A broker who only ever sets spreadMarkup at this
// level (the common case, and every row before 2026-09-07) gets plain
// markup mode exactly as before.
function resolveSpreadAtSymbolLevel(level: SymbolConfigLevel): ResolvedSpread | null {
  if (!level) return null;
  if (level.targetTotalSpreadPips !== null) {
    return { mode: "target", targetTotalSpreadPips: level.targetTotalSpreadPips, fallbackSpreadMarkup: level.spreadMarkup };
  }
  if (level.spreadMarkup !== null) return { mode: "markup", spreadMarkup: level.spreadMarkup };
  return null;
}

// The pure resolver -- every precedence path lives here, no I/O. See
// lib/pricing-engine.test.ts for exhaustive coverage of every fallthrough
// combination.
export function resolvePricingV2(params: ResolvePricingV2Params): ResolvedPricingV2 {
  const spread: ResolvedSpread =
    resolveSpreadAtSymbolLevel(params.accountSymbolConfig) ??
    resolveSpreadAtSymbolLevel(params.accountTypeSymbolConfig) ??
    (params.accountType?.spreadMarkup !== null && params.accountType?.spreadMarkup !== undefined
      ? { mode: "markup", spreadMarkup: params.accountType.spreadMarkup }
      : null) ??
    resolveSpreadAtSymbolLevel(params.groupSymbolConfig) ??
    { mode: "markup", spreadMarkup: params.brokerSpreadMarkup };

  const commissionPerLot =
    firstNonNull(
      params.accountSymbolConfig?.commissionPerLot,
      params.accountTypeSymbolConfig?.commissionPerLot,
      params.accountType?.commissionPerLot,
      params.groupSymbolConfig?.commissionPerLot
    ) ?? params.brokerCommissionPerLot;

  const swapLong =
    firstNonNull(
      params.accountSymbolConfig?.swapLong,
      params.accountTypeSymbolConfig?.swapLong,
      params.accountType?.swapLong,
      params.groupSymbolConfig?.swapLong
    ) ?? params.brokerSwapLong;

  const swapShort =
    firstNonNull(
      params.accountSymbolConfig?.swapShort,
      params.accountTypeSymbolConfig?.swapShort,
      params.accountType?.swapShort,
      params.groupSymbolConfig?.swapShort
    ) ?? params.brokerSwapShort;

  const swapFree = firstNonNull(params.accountSwapFree, params.accountType?.swapFree, params.groupSwapFree) ?? false;

  return { spread, commissionPerLot, swapLong, swapShort, swapFree };
}

// Target-total-spread mode (docs/pricing-engine.md §5): the winning level
// declared a client-visible TOTAL spread instead of a markup -- the
// effective markup is whatever closes the gap between that target and the
// symbol's current live raw spread. Needs the live tick, which
// resolvePricingV2 itself doesn't have (see this module's own top comment
// on why call sites -- not the resolver -- own the live price); call this
// immediately before applySpreadMarkup (lib/group-pricing.ts), same point
// every real fill site already reads its tick.
//
// Three 2026-09-07 decisions baked in here:
// - Q1: if the live base spread is unavailable (null/undefined -- feed
//   down, symbol not quoting, etc.), NEVER block the trade over it. Fall
//   back to the resolved level's own spreadMarkup if it set one alongside
//   the target, else 0 -- the trader still trades, just without that
//   tick's target-spread adjustment applied.
// - Q2: mutual exclusivity between spreadMarkup and targetTotalSpreadPips
//   is gone -- see resolveSpreadAtSymbolLevel's own comment for how both
//   can coexist at one level.
// - Q3: the floor at 0 stays (a client never gets tighter than the live
//   base spread -- broker eats the difference, never a discount), but
//   this is now surfaced as a `warning` rather than silently absorbed, so
//   a broker whose target sits below the real feed spread can see it
//   happening instead of just wondering why realized spread revenue looks
//   thin. Callers (Stage 4) are expected to log/alert on a non-null
//   warning, not treat it as an error -- the trade still fills normally
//   either way.
export function resolveEffectiveSpreadMarkup(
  spread: ResolvedSpread,
  liveBaseSpreadPips: Prisma.Decimal | number | string | null | undefined
): EffectiveSpreadResult {
  if (spread.mode === "markup") return { markup: spread.spreadMarkup, warning: null };

  if (liveBaseSpreadPips === null || liveBaseSpreadPips === undefined) {
    const fallback = spread.fallbackSpreadMarkup ?? new Prisma.Decimal(0);
    return {
      markup: fallback,
      warning: { reason: "base_unavailable", targetTotalSpreadPips: spread.targetTotalSpreadPips, fallbackMarkupUsed: fallback },
    };
  }

  const base = new Prisma.Decimal(liveBaseSpreadPips);
  const diff = spread.targetTotalSpreadPips.sub(base);
  if (diff.isNegative()) {
    return {
      markup: new Prisma.Decimal(0),
      warning: { reason: "target_below_base", targetTotalSpreadPips: spread.targetTotalSpreadPips, liveBaseSpreadPips: base },
    };
  }
  return { markup: diff, warning: null };
}

// DB-fetching wrapper -- Stage 4's real call sites will use this (passing
// the same account/group/symbol ids they already fetch today, plus
// account.accountTypeId), not resolvePricingV2 directly. One query per
// level, same "fetch what this fill needs, resolve in memory" shape as
// lib/group-pricing.ts's own resolveSymbolPricing.
export async function resolveSymbolPricingV2(
  tx: Tx,
  params: {
    accountId: string;
    accountTypeId: string | null | undefined;
    groupId: string | null | undefined;
    symbolId: string;
    brokerSpreadMarkup: Prisma.Decimal;
    brokerCommissionPerLot: Prisma.Decimal;
    brokerSwapLong: Prisma.Decimal;
    brokerSwapShort: Prisma.Decimal;
  }
): Promise<ResolvedPricingV2> {
  const [account, accountSymbolConfig, accountType, accountTypeSymbolConfig, group, groupSymbolConfig] = await Promise.all([
    tx.account.findUniqueOrThrow({ where: { id: params.accountId }, select: { swapFree: true } }),
    tx.accountSymbolConfig.findUnique({
      where: { accountId_symbolId: { accountId: params.accountId, symbolId: params.symbolId } },
    }),
    params.accountTypeId ? tx.accountType.findUnique({ where: { id: params.accountTypeId } }) : Promise.resolve(null),
    params.accountTypeId
      ? tx.accountTypeSymbolConfig.findUnique({
          where: { accountTypeId_symbolId: { accountTypeId: params.accountTypeId, symbolId: params.symbolId } },
        })
      : Promise.resolve(null),
    params.groupId ? tx.group.findUnique({ where: { id: params.groupId }, select: { swapFree: true } }) : Promise.resolve(null),
    params.groupId
      ? tx.groupSymbolConfig.findUnique({ where: { groupId_symbolId: { groupId: params.groupId, symbolId: params.symbolId } } })
      : Promise.resolve(null),
  ]);

  return resolvePricingV2({
    accountSymbolConfig,
    accountTypeSymbolConfig,
    accountType,
    groupSymbolConfig,
    brokerSpreadMarkup: params.brokerSpreadMarkup,
    brokerCommissionPerLot: params.brokerCommissionPerLot,
    brokerSwapLong: params.brokerSwapLong,
    brokerSwapShort: params.brokerSwapShort,
    accountSwapFree: account.swapFree,
    groupSwapFree: group?.swapFree ?? null,
  });
}
