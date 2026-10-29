import { Prisma, type PrismaClient } from "@prisma/client";
import { pipSize } from "@/lib/group-pricing";
import { resolvePricingV2, resolveEffectiveSpreadMarkup, type ResolvedSpread } from "@/lib/pricing-engine";

// Owner decision (2026-10-29): the markup is SYMMETRIC -- divided between the two sides around the mid, instead of
// being added to the ask alone. bid = raw_bid - m/2, ask = raw_ask + m/2, each rounded away from the client (bid down,
// ask up) at the symbol's own precision. The total spread a client sees is raw_spread + m, exactly as before: only the
// split moved. Industry-standard presentation -- a one-sided markup makes SL / TP look "never reached" and the spread
// look wider than it is.
//
// This replaces the ask-only rule of 2026-09-26 ("the bid is never marked up"). EVERY account-side price now moves:
// a BUY opens at the account's ask and CLOSES AT THE ACCOUNT'S BID; a SELL opens at the account's bid and closes at the
// account's ask. That includes each side's SL / TP trigger, its stop-out, and every valuation of an open position at
// the price it would close at (floating P/L, equity, used margin, margin level, the displayed current price).
//
// This module is the one definition of "this account's ask for this symbol". The rule is resolved with EXACTLY the
// fill path's precedence (lib/pricing-engine.ts resolveFillPricing):
//   - pricing engine off: GroupSymbolConfig.spreadMarkup, else BrokerSymbol.spreadMarkup (resolveSymbolPricing);
//   - pricing engine on: AccountSymbolConfig > GroupSymbolConfig > BrokerSymbol (D4: no account-type level),
//     target-total-spread mode included (resolvePricingV2 + resolveEffectiveSpreadMarkup);
//   - the broker's coverage account (a COVERAGE group) is always raw: its legs mirror the real market, never the
//     broker's own markup (lib/coverage.ts).
// The price itself is applySpreadMarkup's formula (half of the markup on each side), so a SELL closing and a BUY
// opening on the same tick at the same account pay the same ask, and a BUY closing and a SELL opening pay the same bid.
// docs/contracts/ask-markup-vectors.json pins it for the engine (Rust) and the clients (WebTrader, the installed
// terminal); lib/ask-markup.test.ts keeps that file honest.

export type AskRule =
  | { mode: "markup"; markupPips: Prisma.Decimal; digits: number }
  | { mode: "target"; targetPips: Prisma.Decimal; fallbackPips: Prisma.Decimal | null; digits: number };

/** No markup on EITHER side -- the raw bid and the raw ask. */
export const RAW_RULE = (digits: number): AskRule => ({ mode: "markup", markupPips: new Prisma.Decimal(0), digits });
/** @deprecated Use RAW_RULE -- since the markup is symmetric, "raw ask" no longer names what this is. */
export const RAW_ASK = RAW_RULE;

/** The rule for an account with no markup on this symbol (no BrokerSymbol row, a coverage account, or a server that
 *  sent none). `digits` is deliberately 0 and irrelevant: a zero markup short-circuits in halfMarkupPrice before any
 *  pip or rounding is read, so both sides come back raw. Use this as the `?? NO_MARKUP` fallback wherever a rule
 *  lookup is nullable -- accountClosePrice now requires one. */
export const NO_MARKUP: AskRule = { mode: "markup", markupPips: new Prisma.Decimal(0), digits: 0 };

/** The rule from a resolved spread (pricing engine on) or a plain markup (off). */
export function askRuleFromSpread(spread: ResolvedSpread, digits: number): AskRule {
  return spread.mode === "target"
    ? { mode: "target", targetPips: spread.targetTotalSpreadPips, fallbackPips: spread.fallbackSpreadMarkup, digits }
    : { mode: "markup", markupPips: spread.spreadMarkup, digits };
}

/** The markup in pips this rule applies at this tick (target mode: whatever lifts the live spread to the target, floored
 *  at 0; no live spread -> the level's own fallback markup, else 0) -- resolveEffectiveSpreadMarkup, unchanged. */
export function markupPipsAt(rule: AskRule, bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value): Prisma.Decimal {
  if (rule.mode === "markup") return rule.markupPips;
  const base = new Prisma.Decimal(ask).sub(new Prisma.Decimal(bid)).div(pipSize(rule.digits));
  return resolveEffectiveSpreadMarkup({ mode: "target", targetTotalSpreadPips: rule.targetPips, fallbackSpreadMarkup: rule.fallbackPips }, base).markup;
}

/** Half of this rule's markup in PRICE units -- the amount EACH side moves under the symmetric (mid-anchored) split.
 *
 *  Symmetric markup (owner decision 2026-10-29, supersedes the ask-only rule of 2026-09-26): the markup is divided
 *  between the two sides instead of being added to the ask alone: bid = raw_bid - m/2, ask = raw_ask + m/2.
 *
 *  That IS the mid-anchored form, for BOTH modes, because `markupPipsAt` already floors m at 0:
 *    mid = (raw_bid + raw_ask)/2,  raw_spread = raw_ask - raw_bid,  m = max(0, target - raw_spread)
 *    raw_ask + m/2 = raw_ask + (target - raw_spread)/2 = mid + target/2
 *    raw_bid - m/2 = raw_bid - (target - raw_spread)/2 = mid - target/2
 *  and when target <= raw_spread, m is 0, so the quote stays exactly raw. So the
 *  `min(raw_bid, mid - target/2)` / `max(raw_ask, mid + target/2)` safety is structural -- never tighter than raw.
 *  The clamps below restate that as an assertion instead of relying on the algebra holding after rounding. */
export function halfMarkupPrice(rule: AskRule, bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value): Prisma.Decimal {
  const m = markupPipsAt(rule, bid, ask);
  return m.isZero() ? new Prisma.Decimal(0) : m.mul(pipSize(rule.digits)).div(2);
}

/** The smallest price this symbol can quote (one unit of its last digit) -- the floor a marked-down bid may not cross. */
function priceFloor(digits: number): Prisma.Decimal {
  return new Prisma.Decimal(1).div(new Prisma.Decimal(10).pow(Math.max(digits, 0)));
}

/** The account's ask: raw ask + m/2, rounded AWAY FROM THE CLIENT (up) at the symbol's own precision, never tighter
 *  than the raw ask. */
export function markedUpAsk(rule: AskRule, bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value): Prisma.Decimal {
  const raw = new Prisma.Decimal(ask);
  const half = halfMarkupPrice(rule, bid, ask);
  if (half.isZero()) return raw;
  return Prisma.Decimal.max(raw.add(half).toDecimalPlaces(rule.digits, Prisma.Decimal.ROUND_CEIL), raw);
}

/** The account's bid: raw bid - m/2, rounded AWAY FROM THE CLIENT (down) at the symbol's own precision, never tighter
 *  than the raw bid, and never at or below zero -- a markup wider than the price itself (the 60-pip hedge group on a
 *  cheap symbol) must degrade to the smallest quotable price, not to a zero or negative bid. */
export function markedDownBid(rule: AskRule, bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value): Prisma.Decimal {
  const raw = new Prisma.Decimal(bid);
  const half = halfMarkupPrice(rule, bid, ask);
  if (half.isZero()) return raw;
  const out = raw.sub(half).toDecimalPlaces(rule.digits, Prisma.Decimal.ROUND_FLOOR);
  return Prisma.Decimal.min(Prisma.Decimal.max(out, priceFloor(rule.digits)), raw);
}

/** Both account-side prices for one tick, with the crossed-book invariant asserted. Throws rather than return a
 *  crossed book: such a quote is never safe to fill or value against. */
export function accountQuote(rule: AskRule, bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value): { bid: Prisma.Decimal; ask: Prisma.Decimal } {
  const out = { bid: markedDownBid(rule, bid, ask), ask: markedUpAsk(rule, bid, ask) };
  if (!out.bid.lt(out.ask)) {
    throw new Error(
      `crossed account book: bid ${out.bid.toString()} >= ask ${out.ask.toString()} ` +
        `(raw ${new Prisma.Decimal(bid).toString()}/${new Prisma.Decimal(ask).toString()}, digits ${rule.digits})`
    );
  }
  return out;
}

/** The price an open position closes at for THIS account: a BUY at the account's BID, a SELL at the account's ask.
 *
 *  `rule` is REQUIRED on purpose (compile guard). Under the ask-only rule a BUY closed at the RAW bid, so any caller
 *  could pass null/undefined and still be right for a BUY. Under the symmetric rule a BUY closes at the account's bid,
 *  so a missing rule is no longer a harmless omission -- it is a wrong price, and a silent P/L and margin-level
 *  discrepancy. Non-nullable turns every such site into a compile error. Pass RAW_RULE(digits) where the account
 *  genuinely has no markup (no BrokerSymbol row, or a coverage account). */
export function accountClosePrice(side: "BUY" | "SELL", bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value, rule: AskRule): Prisma.Decimal {
  return side === "BUY" ? markedDownBid(rule, bid, ask) : markedUpAsk(rule, bid, ask);
}

/** The wire form a client needs to apply the same rule on every tick (lib/trade-api.ts spreadRuleFromPrice).
 *
 *  Symmetric change, kept BACKWARD COMPATIBLE on purpose: `askMarkup` still means "add this to the raw ask", so it now
 *  carries m/2 rather than m, and the new `bidMarkup` means "subtract this from the raw bid" (also m/2). A client that
 *  reads only `askMarkup` -- an installed terminal that has not been updated, on a broker still doing the markup
 *  client-side (Broker.clientAskServerSideAt null) -- therefore gets the correct ask and a raw bid: narrower than it
 *  should be on the bid only, never crossed and never wrong on the ask. A client that reads both is exact.
 *  `targetSpread` is unchanged: it is the TOTAL target spread, not a per-side figure. */
export function askRuleWire(
  rule: AskRule,
  bid?: Prisma.Decimal.Value | null,
  ask?: Prisma.Decimal.Value | null
): { askMarkup: string; bidMarkup: string; spreadRule: "markup" | "target"; targetSpread?: string } {
  const pip = pipSize(rule.digits);
  const half = (mPips: Prisma.Decimal) => mPips.mul(pip).div(2).toString();
  if (rule.mode === "target") {
    const m = bid != null && ask != null ? markupPipsAt(rule, bid, ask) : (rule.fallbackPips ?? new Prisma.Decimal(0));
    return { askMarkup: half(m), bidMarkup: half(m), spreadRule: "target", targetSpread: rule.targetPips.mul(pip).toString() };
  }
  return { askMarkup: half(rule.markupPips), bidMarkup: half(rule.markupPips), spreadRule: "markup" };
}

type Db = PrismaClient | Prisma.TransactionClient;
export type AskRuleKey = { accountId: string; symbolId: string };
export type AskRules = { get(accountId: string, symbolId: string): AskRule | null };

/**
 * The ask rule of every (account, symbol) pair asked for, in a constant number of queries whatever the number of pairs
 * (accounts, brokers, broker symbols, symbols, group configs, and -- for a pricing-engine broker -- account types and
 * their / the accounts' own per-symbol configs). A pair whose account or broker symbol is gone resolves to null, which
 * every caller treats as the raw ask.
 */
export async function loadAskRules(db: Db, pairs: AskRuleKey[]): Promise<AskRules> {
  const map = new Map<string, AskRule>();
  const key = (a: string, s: string) => `${a}|${s}`;
  const result: AskRules = { get: (a, s) => map.get(key(a, s)) ?? null };
  if (pairs.length === 0) return result;
  const accountIds = [...new Set(pairs.map((p) => p.accountId))];
  const symbolIds = [...new Set(pairs.map((p) => p.symbolId))];

  const [accounts, symbols] = await Promise.all([
    db.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, brokerId: true, groupId: true, group: { select: { category: true } } } }),
    db.symbol.findMany({ where: { id: { in: symbolIds } }, select: { id: true, digits: true } }),
  ]);
  const brokerIds = [...new Set(accounts.map((a) => a.brokerId))];
  const groupIds = [...new Set(accounts.map((a) => a.groupId))];
  const [brokers, brokerSymbols, groupConfigs] = await Promise.all([
    db.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, pricingEngineEnabled: true, coverageAccountId: true } }),
    db.brokerSymbol.findMany({ where: { brokerId: { in: brokerIds }, symbolId: { in: symbolIds } }, select: { brokerId: true, symbolId: true, spreadMarkup: true, commissionPerLot: true, swapLong: true, swapShort: true } }),
    db.groupSymbolConfig.findMany({ where: { groupId: { in: groupIds }, symbolId: { in: symbolIds } }, select: { groupId: true, symbolId: true, spreadMarkup: true, targetTotalSpreadPips: true, commissionPerLot: true, swapLong: true, swapShort: true } }),
  ]);
  const brokerById = new Map(brokers.map((b) => [b.id, b]));
  const engineAccounts = accounts.filter((a) => brokerById.get(a.brokerId)?.pricingEngineEnabled);
  const [accountConfigs] = engineAccounts.length === 0
    ? [[]]
    : await Promise.all([
        db.accountSymbolConfig.findMany({ where: { accountId: { in: engineAccounts.map((a) => a.id) }, symbolId: { in: symbolIds } }, select: { accountId: true, symbolId: true, spreadMarkup: true, targetTotalSpreadPips: true, commissionPerLot: true, swapLong: true, swapShort: true } }),
      ]);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const digitsBySymbol = new Map(symbols.map((s) => [s.id, s.digits]));
  const brokerSymbolBy = new Map(brokerSymbols.map((b) => [`${b.brokerId}|${b.symbolId}`, b]));
  const groupConfigBy = new Map(groupConfigs.map((c) => [`${c.groupId}|${c.symbolId}`, c]));
  const accountConfigBy = new Map(accountConfigs.map((c) => [`${c.accountId}|${c.symbolId}`, c]));

  for (const { accountId, symbolId } of pairs) {
    const a = accountById.get(accountId);
    const digits = digitsBySymbol.get(symbolId);
    if (!a || digits == null) continue;
    const broker = brokerById.get(a.brokerId);
    const bs = brokerSymbolBy.get(`${a.brokerId}|${symbolId}`);
    if (!broker || !bs) continue;
    if (a.group?.category === "COVERAGE" || broker.coverageAccountId === a.id) {
      map.set(key(accountId, symbolId), RAW_ASK(digits));
      continue;
    }
    const gsc = groupConfigBy.get(`${a.groupId}|${symbolId}`) ?? null;
    if (!broker.pricingEngineEnabled) {
      // resolveSymbolPricing: the group's markup when it sets one, else the broker's
      map.set(key(accountId, symbolId), { mode: "markup", markupPips: gsc?.spreadMarkup ?? bs.spreadMarkup, digits });
      continue;
    }
    const resolved = resolvePricingV2({
      accountSymbolConfig: accountConfigBy.get(`${accountId}|${symbolId}`) ?? null,
      groupSymbolConfig: gsc,
      brokerSpreadMarkup: bs.spreadMarkup,
      brokerCommissionPerLot: bs.commissionPerLot,
      brokerSwapLong: bs.swapLong,
      brokerSwapShort: bs.swapShort,
      accountSwapFree: null,
      groupSwapFree: null,
    });
    map.set(key(accountId, symbolId), askRuleFromSpread(resolved.spread, digits));
  }
  return result;
}

/** One account's rules for every symbol it is asked about (the common single-account case). */
export async function loadAccountAskRules(db: Db, accountId: string, symbolIds: string[]): Promise<(symbolId: string) => AskRule | null> {
  const rules = await loadAskRules(db, symbolIds.map((symbolId) => ({ accountId, symbolId })));
  return (symbolId) => rules.get(accountId, symbolId);
}

/** The rules a set of positions needs to be valued at their close-side price.
 *
 *  Symmetric markup (2026-10-29) replaced `loadSellAskRules`, which resolved SELL positions ONLY because under the
 *  ask-only rule a BUY closed at the raw bid and needed no rule at all. Both sides now carry half the markup, so BOTH
 *  sides need one. The cost of that is bounded on purpose: `loadAskRules` is a BATCHED read (5-6 queries over id
 *  arrays, never one per position), so dropping the SELL filter widens the `IN` lists and does not multiply queries.
 *  The one real regression is that a book of only BUY positions used to issue no query and now issues one -- which is
 *  what `askRulesCached` (lib/ask-markup-cache.ts) removes for the steady state.
 *
 *  Owner decision 2026-10-30: no per-position query; markup-0 short-circuits (the rule resolves to RAW and both sides
 *  come back raw with no arithmetic); non-zero markups come from the per-cycle config cache. */
export function loadCloseAskRules(db: Db, positions: { accountId: string; symbolId: string; side: "BUY" | "SELL" }[]): Promise<AskRules> {
  return loadAskRules(db, positions.map((p) => ({ accountId: p.accountId, symbolId: p.symbolId })));
}

/** A position's close price for valuation: the account's BID for a BUY, the account's ask for a SELL. A pair with no
 *  resolved rule (an account or symbol the batch did not cover) is treated as having no markup, i.e. raw on both
 *  sides -- the same fallback the ask-only version used for a missing rule. */
export function valuationClosePrice(rules: AskRules, p: { accountId: string; symbolId: string; side: "BUY" | "SELL" }, bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value): Prisma.Decimal {
  return accountClosePrice(p.side, bid, ask, rules.get(p.accountId, p.symbolId) ?? NO_MARKUP);
}
