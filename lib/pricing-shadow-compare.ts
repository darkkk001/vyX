// No "server-only" import here (unlike most of this app's lib/*.ts) --
// deliberately, since scripts/pricing-shadow-compare.ts needs to run this
// standalone via `tsx`, outside any Next.js server context, to check
// production directly without deploying first.
import { Prisma, PrismaClient } from "@prisma/client";
import { resolveSymbolPricing, pipSize } from "@/lib/group-pricing";
import { resolveSymbolPricingV2, resolveEffectiveSpreadMarkup } from "@/lib/pricing-engine";

// Phase 2 pricing engine, Stage 3 -- shadow comparison. READ-ONLY: no
// write anywhere in this file. Computes, for every (account, tradable
// symbol) pair at a broker, both:
//   - OLD: exactly what a real fill charges TODAY -- lib/group-pricing.ts's
//     own resolveSymbolPricing, called directly, for spread/commission;
//     for swap, a faithful copy of lib/swap-rollover.ts's resolveSwapRate
//     logic (see oldSwapRateForSide's own comment for why it's a copy,
//     not a direct call) -- together these mirror the two functions
//     actually wired into a real fill/rollover right now. swapFree's
//     "old" value is hardcoded false
//     for every account, not resolved from any field, because nothing live
//     reads Account/AccountType/Group.swapFree today (storage only) --
//     see those fields' own schema comments. This is the true baseline: a
//     broker's Broker.pricingEngineEnabled flag is off, so this is what
//     every real position is priced at right now, regardless of what any
//     AccountType/override table says.
//   - NEW: the full Stage 2 resolver (lib/pricing-engine.ts's
//     resolveSymbolPricingV2), what the SAME pair would price at the
//     moment a broker's flag flips on.
// Only rows where they DIFFER are returned -- for the overwhelming
// majority of accounts (no AccountType/override pricing has ever been set
// beyond storage), old and new are identical, so a clean report full of
// zero diffs is the expected, reassuring result, not a bug.

export type ShadowFieldDiff = {
  field: "spreadMarkup" | "commissionPerLot" | "swapLong" | "swapShort" | "swapFree";
  oldValue: string;
  newValue: string;
};

export type ShadowSpreadInfo = {
  mode: "markup" | "target";
  // Only present for target mode: the live base spread (pips) used to
  // collapse it, if a tick was available -- null if no LivePrice row
  // exists for this symbol, in which case Q1's no-live-base fallback is
  // what "newValue" above reflects.
  liveBaseSpreadPips: string | null;
  warning: { reason: "target_below_base" | "base_unavailable" } | null;
};

export type ShadowDiffRow = {
  accountId: string;
  accountNumber: string;
  symbolId: string;
  symbolName: string;
  hasOpenPosition: boolean;
  fields: ShadowFieldDiff[];
  spreadInfo: ShadowSpreadInfo | null; // set only when spreadMarkup/spread itself is one of the diffed fields
};

export type ShadowComparisonSummary = {
  brokerId: string;
  accountsChecked: number;
  symbolsChecked: number;
  comparisonsRun: number;
  accountsWithAnyDiff: number;
  diffs: ShadowDiffRow[];
};

function decimalsEqual(a: Prisma.Decimal, b: Prisma.Decimal): boolean {
  return a.eq(b);
}

// Deliberately NOT imported from lib/swap-rollover.ts -- that file's own
// `import "server-only"` is fine inside Next (and under vitest, which
// aliases it away -- see vitest.config.mts), but would break this
// module's other real caller, scripts/pricing-shadow-compare.ts, which
// must run standalone via `tsx` outside any Next/vitest context. The
// logic below is a byte-for-byte copy of lib/swap-rollover.ts's own
// resolveSwapRate -- if that function's resolution order ever changes,
// this copy needs the same change or "old" here silently drifts from
// what the real rollover job actually charges.
type SwapOverride = { swapLong: Prisma.Decimal; swapShort: Prisma.Decimal } | null;
function oldSwapRateForSide(side: "BUY" | "SELL", groupOverride: SwapOverride, brokerSwapLong: Prisma.Decimal, brokerSwapShort: Prisma.Decimal): Prisma.Decimal {
  const source = groupOverride ?? { swapLong: brokerSwapLong, swapShort: brokerSwapShort };
  return side === "BUY" ? source.swapLong : source.swapShort;
}
function oldSwapRates(groupOverride: SwapOverride, brokerSwapLong: Prisma.Decimal, brokerSwapShort: Prisma.Decimal) {
  return {
    swapLong: oldSwapRateForSide("BUY", groupOverride, brokerSwapLong, brokerSwapShort),
    swapShort: oldSwapRateForSide("SELL", groupOverride, brokerSwapLong, brokerSwapShort),
  };
}

export async function runShadowPricingComparison(db: PrismaClient, brokerId: string): Promise<ShadowComparisonSummary> {
  const [accounts, brokerSymbols, groupSymbolConfigs, openPositions] = await Promise.all([
    db.account.findMany({
      where: { brokerId },
      select: { id: true, accountNumber: true, groupId: true, accountTypeId: true },
    }),
    db.brokerSymbol.findMany({
      where: { brokerId, enabled: true },
      include: { symbol: { select: { id: true, name: true, digits: true } } },
    }),
    db.groupSymbolConfig.findMany({ where: { group: { brokerId } } }),
    db.position.findMany({ where: { brokerId, status: "OPEN" }, select: { accountId: true, symbolId: true } }),
  ]);

  const symbolNames = brokerSymbols.map((bs) => bs.symbol.name);
  const livePriceMap = new Map((await db.livePrice.findMany({ where: { symbol: { in: symbolNames } } })).map((lp) => [lp.symbol, lp]));

  const groupOverrideMap = new Map(groupSymbolConfigs.map((g) => [`${g.groupId}:${g.symbolId}`, g]));
  const openPositionSet = new Set(openPositions.map((p) => `${p.accountId}:${p.symbolId}`));

  const diffs: ShadowDiffRow[] = [];
  const accountsWithDiff = new Set<string>();
  let comparisonsRun = 0;

  for (const account of accounts) {
    for (const bs of brokerSymbols) {
      comparisonsRun++;

      const groupOverride = account.groupId ? (groupOverrideMap.get(`${account.groupId}:${bs.symbolId}`) ?? null) : null;

      const [oldSpreadCommission, newPricing] = await Promise.all([
        resolveSymbolPricing(db, {
          groupId: account.groupId,
          symbolId: bs.symbolId,
          brokerSpreadMarkup: bs.spreadMarkup,
          brokerCommissionPerLot: bs.commissionPerLot,
        }),
        resolveSymbolPricingV2(db, {
          accountId: account.id,
          accountTypeId: account.accountTypeId,
          groupId: account.groupId,
          symbolId: bs.symbolId,
          brokerSpreadMarkup: bs.spreadMarkup,
          brokerCommissionPerLot: bs.commissionPerLot,
          brokerSwapLong: bs.swapLong,
          brokerSwapShort: bs.swapShort,
        }),
      ]);

      const oldSwap = oldSwapRates(
        groupOverride ? { swapLong: groupOverride.swapLong ?? bs.swapLong, swapShort: groupOverride.swapShort ?? bs.swapShort } : null,
        bs.swapLong,
        bs.swapShort
      );
      const oldSwapFree = false; // nothing live reads any swapFree field today -- see this module's own top comment

      const livePrice = livePriceMap.get(bs.symbol.name);
      const liveBaseSpreadPips = livePrice ? livePrice.ask.sub(livePrice.bid).div(pipSize(bs.symbol.digits)) : null;

      const fields: ShadowFieldDiff[] = [];
      let spreadInfo: ShadowSpreadInfo | null = null;

      // Spread: compare old's flat markup against new's EFFECTIVE markup
      // (collapsing target mode against a live tick when one exists, same
      // helper a real fill would use -- Q1/Q2/Q3, 2026-09-07).
      const effective = resolveEffectiveSpreadMarkup(newPricing.spread, liveBaseSpreadPips ?? null);
      if (!decimalsEqual(oldSpreadCommission.spreadMarkup, effective.markup)) {
        fields.push({ field: "spreadMarkup", oldValue: oldSpreadCommission.spreadMarkup.toString(), newValue: effective.markup.toString() });
        spreadInfo = {
          mode: newPricing.spread.mode,
          liveBaseSpreadPips: liveBaseSpreadPips ? liveBaseSpreadPips.toString() : null,
          warning: effective.warning ? { reason: effective.warning.reason } : null,
        };
      }

      if (!decimalsEqual(oldSpreadCommission.commissionPerLot, newPricing.commissionPerLot)) {
        fields.push({ field: "commissionPerLot", oldValue: oldSpreadCommission.commissionPerLot.toString(), newValue: newPricing.commissionPerLot.toString() });
      }
      if (!decimalsEqual(oldSwap.swapLong, newPricing.swapLong)) {
        fields.push({ field: "swapLong", oldValue: oldSwap.swapLong.toString(), newValue: newPricing.swapLong.toString() });
      }
      if (!decimalsEqual(oldSwap.swapShort, newPricing.swapShort)) {
        fields.push({ field: "swapShort", oldValue: oldSwap.swapShort.toString(), newValue: newPricing.swapShort.toString() });
      }
      if (oldSwapFree !== newPricing.swapFree) {
        fields.push({ field: "swapFree", oldValue: String(oldSwapFree), newValue: String(newPricing.swapFree) });
      }

      if (fields.length > 0) {
        accountsWithDiff.add(account.id);
        diffs.push({
          accountId: account.id,
          accountNumber: account.accountNumber,
          symbolId: bs.symbolId,
          symbolName: bs.symbol.name,
          hasOpenPosition: openPositionSet.has(`${account.id}:${bs.symbolId}`),
          fields,
          spreadInfo,
        });
      }
    }
  }

  return {
    brokerId,
    accountsChecked: accounts.length,
    symbolsChecked: brokerSymbols.length,
    comparisonsRun,
    accountsWithAnyDiff: accountsWithDiff.size,
    diffs,
  };
}
