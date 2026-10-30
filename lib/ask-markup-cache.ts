import type { Prisma, PrismaClient } from "@prisma/client";
import { askRuleFromSpread, NO_MARKUP, RAW_RULE, type AskRule, type AskRuleKey, type AskRules } from "@/lib/ask-markup";
import { resolvePricingV2 } from "@/lib/pricing-engine";

// Per-cycle markup-config cache (owner decision 2026-10-30: "markup-0 short-circuits; non-zero comes from a
// per-cycle cache of the CONFIG; no per-position query; query volume capped on config rows, not position count;
// cache-aside").
//
// WHAT IS CACHED, AND WHY THAT SHAPE. The four pricing LEVELS and the two lookups they need -- not resolved
// (account, symbol) answers. Measured on this platform 2026-10-30:
//
//     BrokerSymbol        125      GroupSymbolConfig    50      AccountSymbolConfig   0
//     Broker                8      Symbol               43      Account              62      = 288 rows
//
// All bounded and slow-changing (a markup edit, a new symbol, an account moving group). Resolution then happens IN
// MEMORY, per (account, symbol), with exactly loadAskRules' precedence.
//
// Caching RESOLVED pairs instead would have been wrong for this constraint: the key space is accounts x symbols
// (62 x 43 = 2,666 here, and it grows with the business), so every pair not seen yet is a miss and a fresh read --
// query volume would scale with account/symbol combinations rather than with the configuration. Caching the levels
// caps it at the six reads below per TTL however many positions, accounts or symbols appear. This is the same shape
// the engine already uses (engine/market-data/src/ask_markup.rs PricingSnapshot, held in memory and reloaded on a
// config event, for the same Neon-compute reason -- the 2026-09-26 quota outage).
//
// MARKUP-0 SHORT-CIRCUIT. A resolved rule of zero markup costs nothing beyond the lookup: halfMarkupPrice returns 0
// and markedDownBid / markedUpAsk hand back the raw bid and ask untouched. So for a symbol whose levels are all zero
// -- XAUUSD, where every broker's BrokerSymbol.spreadMarkup is 0 and the group has no row -- a BUY still closes at
// the raw bid, exactly as under the ask-only rule, and the hot path performs no query at all once warm.
//
// CACHE-ASIDE. A caller asks for the pairs it needs; if the levels are warm nothing is read. On a cold or expired
// snapshot the six reads below run once and are written back. Nothing reads on its own schedule, so a quiet platform
// makes no queries.
//
// STALENESS. A config change lands within TTL_MS, or at once via invalidateAskRules() wherever the app handles
// ConfigChanged / AccountUpdated (the api-gateway does the same for its own rule cache).

type Db = PrismaClient | Prisma.TransactionClient;

/** How long the cached levels are reused. A markup edit lands within this long unless invalidateAskRules() runs. */
export const ASK_RULE_TTL_MS = 60_000;

type Lvl = { spreadMarkup: Prisma.Decimal | null; targetTotalSpreadPips: Prisma.Decimal | null; commissionPerLot: Prisma.Decimal | null; swapLong: Prisma.Decimal | null; swapShort: Prisma.Decimal | null };

type Levels = {
  at: number;
  /** account id -> its broker, group and whether that group is COVERAGE */
  accounts: Map<string, { brokerId: string; groupId: string | null; coverageGroup: boolean }>;
  /** broker id -> its pricing switches */
  brokers: Map<string, { pricingEngineEnabled: boolean; coverageAccountId: string | null }>;
  /** symbol id -> digits */
  digits: Map<string, number>;
  /** `brokerId|symbolId` -> BrokerSymbol (the only level that is NOT NULL when the row exists) */
  brokerSymbol: Map<string, { spreadMarkup: Prisma.Decimal; commissionPerLot: Prisma.Decimal; swapLong: Prisma.Decimal; swapShort: Prisma.Decimal }>;
  /** `groupId|symbolId` -> GroupSymbolConfig */
  groupConfig: Map<string, Lvl>;
  /** `accountId|symbolId` -> AccountSymbolConfig (read only for a pricing-engine broker) */
  accountConfig: Map<string, Lvl>;
};

let levels: Levels | null = null;
let inflight: Promise<Levels> | null = null;

/** Drop the cached configuration. Call from the ConfigChanged / AccountUpdated handling so a markup edit is visible
 *  immediately instead of within ASK_RULE_TTL_MS. The levels are platform-wide, so this clears all of them; it is one
 *  cheap reload, not a per-account invalidation. */
export function invalidateAskRules(): void {
  levels = null;
  inflight = null;
}

/** Test / diagnostic view: how many config rows are held, and when they were read. */
export function askRuleCacheStats(): { rows: number; at: number | null } {
  if (!levels) return { rows: 0, at: null };
  const l = levels;
  return { rows: l.accounts.size + l.brokers.size + l.digits.size + l.brokerSymbol.size + l.groupConfig.size + l.accountConfig.size, at: l.at };
}

async function readLevels(db: Db, now: number): Promise<Levels> {
  // Six reads of whole, bounded tables -- no id arrays, so the cost does not depend on what the caller asked for.
  const [accounts, brokers, symbols, brokerSymbols, groupConfigs, accountConfigs] = await Promise.all([
    db.account.findMany({ select: { id: true, brokerId: true, groupId: true, group: { select: { category: true } } } }),
    db.broker.findMany({ select: { id: true, pricingEngineEnabled: true, coverageAccountId: true } }),
    db.symbol.findMany({ select: { id: true, digits: true } }),
    db.brokerSymbol.findMany({ select: { brokerId: true, symbolId: true, spreadMarkup: true, commissionPerLot: true, swapLong: true, swapShort: true } }),
    db.groupSymbolConfig.findMany({ select: { groupId: true, symbolId: true, spreadMarkup: true, targetTotalSpreadPips: true, commissionPerLot: true, swapLong: true, swapShort: true } }),
    db.accountSymbolConfig.findMany({ select: { accountId: true, symbolId: true, spreadMarkup: true, targetTotalSpreadPips: true, commissionPerLot: true, swapLong: true, swapShort: true } }),
  ]);
  const lvl = (c: { spreadMarkup: Prisma.Decimal | null; targetTotalSpreadPips: Prisma.Decimal | null; commissionPerLot: Prisma.Decimal | null; swapLong: Prisma.Decimal | null; swapShort: Prisma.Decimal | null }): Lvl => ({
    spreadMarkup: c.spreadMarkup,
    targetTotalSpreadPips: c.targetTotalSpreadPips,
    commissionPerLot: c.commissionPerLot,
    swapLong: c.swapLong,
    swapShort: c.swapShort,
  });
  return {
    at: now,
    accounts: new Map(accounts.map((a) => [a.id, { brokerId: a.brokerId, groupId: a.groupId, coverageGroup: a.group?.category === "COVERAGE" }])),
    brokers: new Map(brokers.map((b) => [b.id, { pricingEngineEnabled: b.pricingEngineEnabled, coverageAccountId: b.coverageAccountId }])),
    digits: new Map(symbols.map((s) => [s.id, s.digits])),
    brokerSymbol: new Map(brokerSymbols.map((b) => [`${b.brokerId}|${b.symbolId}`, { spreadMarkup: b.spreadMarkup, commissionPerLot: b.commissionPerLot, swapLong: b.swapLong, swapShort: b.swapShort }])),
    groupConfig: new Map(groupConfigs.map((c) => [`${c.groupId}|${c.symbolId}`, lvl(c)])),
    accountConfig: new Map(accountConfigs.map((c) => [`${c.accountId}|${c.symbolId}`, lvl(c)])),
  };
}

/** Cache-aside: warm levels are reused, a cold or expired snapshot is read once. Concurrent callers share one read. */
async function getLevels(db: Db, now: number): Promise<Levels> {
  if (levels && now - levels.at < ASK_RULE_TTL_MS) return levels;
  if (inflight) return inflight;
  inflight = readLevels(db, now)
    .then((l) => {
      levels = l;
      return l;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** One pair's rule from the cached levels, with EXACTLY loadAskRules' precedence (lib/ask-markup.ts): no BrokerSymbol
 *  row = no rule; a coverage account = raw; pricing engine off = the group's markup else the broker's; on =
 *  AccountSymbolConfig > GroupSymbolConfig > BrokerSymbol, a level's target winning within it. */
function ruleFrom(l: Levels, accountId: string, symbolId: string): AskRule | null {
  const a = l.accounts.get(accountId);
  const digits = l.digits.get(symbolId);
  if (!a || digits == null || a.groupId == null) return null;
  const broker = l.brokers.get(a.brokerId);
  const bs = l.brokerSymbol.get(`${a.brokerId}|${symbolId}`);
  if (!broker || !bs) return null;
  if (a.coverageGroup || broker.coverageAccountId === accountId) return RAW_RULE(digits);
  const gsc = l.groupConfig.get(`${a.groupId}|${symbolId}`) ?? null;
  if (!broker.pricingEngineEnabled) {
    return { mode: "markup", markupPips: gsc?.spreadMarkup ?? bs.spreadMarkup, digits };
  }
  const resolved = resolvePricingV2({
    accountSymbolConfig: l.accountConfig.get(`${accountId}|${symbolId}`) ?? null,
    groupSymbolConfig: gsc,
    brokerSpreadMarkup: bs.spreadMarkup,
    brokerCommissionPerLot: bs.commissionPerLot,
    brokerSwapLong: bs.swapLong,
    brokerSwapShort: bs.swapShort,
    accountSwapFree: null,
    groupSwapFree: null,
  });
  return askRuleFromSpread(resolved.spread, digits);
}

/**
 * The rules for `pairs`, resolved in memory from the cached configuration.
 *
 * Answers for every pair asked for: a pair that resolves to nothing answers `NO_MARKUP` (raw on both sides), the same
 * fallback the ask-only code used for a missing rule, so callers never handle `null`.
 */
export async function askRulesCached(db: Db, pairs: AskRuleKey[], now: number = Date.now()): Promise<AskRules> {
  if (pairs.length === 0) return { get: () => null };
  const l = await getLevels(db, now);
  const resolved = new Map<string, AskRule>();
  for (const p of pairs) resolved.set(`${p.accountId}|${p.symbolId}`, ruleFrom(l, p.accountId, p.symbolId) ?? NO_MARKUP);
  return { get: (a, s) => resolved.get(`${a}|${s}`) ?? null };
}

/** `askRulesCached` for a set of positions -- the cached counterpart of lib/ask-markup.ts loadCloseAskRules. */
export function closeAskRulesCached(
  db: Db,
  positions: { accountId: string; symbolId: string; side: "BUY" | "SELL" }[],
  now?: number
): Promise<AskRules> {
  return askRulesCached(db, positions.map((p) => ({ accountId: p.accountId, symbolId: p.symbolId })), now);
}
