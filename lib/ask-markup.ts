import { Prisma, type PrismaClient } from "@prisma/client";
import { pipSize } from "@/lib/group-pricing";
import { resolvePricingV2, resolveEffectiveSpreadMarkup, type ResolvedSpread } from "@/lib/pricing-engine";

// Owner decision (2026-09-26): EVERY ask-side execution uses the account's marked-up ask -- a BUY open (as before)
// AND a SELL close, including a SELL's SL / TP trigger, its stop-out, and every valuation of an open SELL at the price
// it would close at (floating P/L, equity, used margin, margin level, the displayed current price). A BUY closes at
// the raw bid, a SELL opens at the raw bid: the bid is never marked up.
//
// This module is the one definition of "this account's ask for this symbol". The rule is resolved with EXACTLY the
// fill path's precedence (lib/pricing-engine.ts resolveFillPricing):
//   - pricing engine off: GroupSymbolConfig.spreadMarkup, else BrokerSymbol.spreadMarkup (resolveSymbolPricing);
//   - pricing engine on: AccountSymbolConfig > AccountTypeSymbolConfig > AccountType > GroupSymbolConfig > BrokerSymbol,
//     target-total-spread mode included (resolvePricingV2 + resolveEffectiveSpreadMarkup);
//   - the broker's coverage account (a COVERAGE group) is always raw: its legs mirror the real market, never the
//     broker's own markup (lib/coverage.ts).
// The price itself is applySpreadMarkup's formula (ask + markup x pip), so a SELL closing and a BUY opening on the same
// tick at the same account pay the same ask. docs/contracts/ask-markup-vectors.json pins it for the engine (Rust) and
// the clients (C#, WebTrader); lib/ask-markup.test.ts keeps that file honest.

export type AskRule =
  | { mode: "markup"; markupPips: Prisma.Decimal; digits: number }
  | { mode: "target"; targetPips: Prisma.Decimal; fallbackPips: Prisma.Decimal | null; digits: number };

export const RAW_ASK = (digits: number): AskRule => ({ mode: "markup", markupPips: new Prisma.Decimal(0), digits });

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

/** The account's ask: raw ask + markup x pip (lib/group-pricing.ts applySpreadMarkup's formula). */
export function markedUpAsk(rule: AskRule, bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value): Prisma.Decimal {
  const raw = new Prisma.Decimal(ask);
  const m = markupPipsAt(rule, bid, ask);
  return m.isZero() ? raw : raw.add(m.mul(pipSize(rule.digits)));
}

/** The price an open position closes at for THIS account: a BUY at the raw bid, a SELL at the account's ask. */
export function accountClosePrice(side: "BUY" | "SELL", bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value, rule: AskRule | null | undefined): Prisma.Decimal {
  if (side === "BUY") return new Prisma.Decimal(bid);
  return rule ? markedUpAsk(rule, bid, ask) : new Prisma.Decimal(ask);
}

/** The wire form a client needs to apply the same rule on every tick (lib/trade-api.ts spreadRuleFromPrice): the
 *  markup in price units at this tick, and the target in price units when in target mode. */
export function askRuleWire(rule: AskRule, bid?: Prisma.Decimal.Value | null, ask?: Prisma.Decimal.Value | null): { askMarkup: string; spreadRule: "markup" | "target"; targetSpread?: string } {
  const pip = pipSize(rule.digits);
  if (rule.mode === "target") {
    const m = bid != null && ask != null ? markupPipsAt(rule, bid, ask) : (rule.fallbackPips ?? new Prisma.Decimal(0));
    return { askMarkup: m.mul(pip).toString(), spreadRule: "target", targetSpread: rule.targetPips.mul(pip).toString() };
  }
  return { askMarkup: rule.markupPips.mul(pip).toString(), spreadRule: "markup" };
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
    db.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, brokerId: true, groupId: true, accountTypeId: true, group: { select: { category: true } } } }),
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
  const typeIds = [...new Set(engineAccounts.map((a) => a.accountTypeId).filter((t): t is string => t != null))];
  const [types, typeConfigs, accountConfigs] = engineAccounts.length === 0
    ? [[], [], []]
    : await Promise.all([
        typeIds.length ? db.accountType.findMany({ where: { id: { in: typeIds } }, select: { id: true, spreadMarkup: true, commissionPerLot: true, swapLong: true, swapShort: true, swapFree: true } }) : Promise.resolve([]),
        typeIds.length ? db.accountTypeSymbolConfig.findMany({ where: { accountTypeId: { in: typeIds }, symbolId: { in: symbolIds } }, select: { accountTypeId: true, symbolId: true, spreadMarkup: true, targetTotalSpreadPips: true, commissionPerLot: true, swapLong: true, swapShort: true } }) : Promise.resolve([]),
        db.accountSymbolConfig.findMany({ where: { accountId: { in: engineAccounts.map((a) => a.id) }, symbolId: { in: symbolIds } }, select: { accountId: true, symbolId: true, spreadMarkup: true, targetTotalSpreadPips: true, commissionPerLot: true, swapLong: true, swapShort: true } }),
      ]);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const digitsBySymbol = new Map(symbols.map((s) => [s.id, s.digits]));
  const brokerSymbolBy = new Map(brokerSymbols.map((b) => [`${b.brokerId}|${b.symbolId}`, b]));
  const groupConfigBy = new Map(groupConfigs.map((c) => [`${c.groupId}|${c.symbolId}`, c]));
  const typeById = new Map(types.map((t) => [t.id, t]));
  const typeConfigBy = new Map(typeConfigs.map((c) => [`${c.accountTypeId}|${c.symbolId}`, c]));
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
      accountTypeSymbolConfig: a.accountTypeId ? (typeConfigBy.get(`${a.accountTypeId}|${symbolId}`) ?? null) : null,
      accountType: a.accountTypeId ? (typeById.get(a.accountTypeId) ?? null) : null,
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

/** The rules a set of positions needs to be valued at their close-side price: only a SELL closes at the ask, so only
 *  SELL positions are resolved (none = no query at all). */
export function loadSellAskRules(db: Db, positions: { accountId: string; symbolId: string; side: "BUY" | "SELL" }[]): Promise<AskRules> {
  return loadAskRules(db, positions.filter((p) => p.side === "SELL").map((p) => ({ accountId: p.accountId, symbolId: p.symbolId })));
}

/** A position's close-side ask for valuation: the account's ask for a SELL; a BUY never reads it (it closes at bid). */
export function valuationAsk(rules: AskRules, p: { accountId: string; symbolId: string; side: "BUY" | "SELL" }, bid: Prisma.Decimal.Value, ask: Prisma.Decimal.Value): Prisma.Decimal {
  return p.side === "SELL" ? accountClosePrice("SELL", bid, ask, rules.get(p.accountId, p.symbolId)) : new Prisma.Decimal(ask);
}
