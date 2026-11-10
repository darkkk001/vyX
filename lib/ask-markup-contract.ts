import { Prisma } from "@prisma/client";
import { resolvePricingV2 } from "@/lib/pricing-engine";
import { accountClosePrice, askRuleFromSpread, askRuleWire, markupParts, markedDownBid, markedUpAsk, markupPipsAt, type AskRule } from "@/lib/ask-markup";

// docs/contracts/ask-markup-vectors.json, generated from the server's own functions (lib/ask-markup.ts): the engine
// (Rust, order-management) and the clients (C# terminal / backoffice, WebTrader) are pinned to it. Two parts:
//   - resolution: which level's spread wins for an (account, symbol), pricing engine on or off, coverage raw;
//   - prices: the account's ask, and each side's close price, at a tick, for a markup or a target rule.
// scripts/contracts/gen-ask-markup-vectors.ts writes it; lib/ask-markup.test.ts fails if file and server disagree.

type Lvl = { spreadMarkup: string | null; targetTotalSpreadPips: string | null } | null;
export type ResolutionInput = {
  name: string;
  pricingEngineEnabled: boolean;
  coverage: boolean;
  digits: number;
  broker: string; // BrokerSymbol.spreadMarkup
  group: Lvl; // GroupSymbolConfig
  // D4 (owner: the group is the pricing tier): no account-type levels. The engine's reader (engine/market-data
  // ask_markup.rs) still has them; with no vector setting them it reads them as absent (null) -- they must go there too
  // with the D8 engine work. No live account type sets a spread (checked 2026-09-30).
  accountSymbol: Lvl; // AccountSymbolConfig
};
// Commission resolution (2026-11-10, engine / web parity): which level's commissionPerLot a fill charges, and the charge.
// The same precedence as the spread, per FIELD (a level whose commission is null falls through even when the row exists):
//   pricing engine off (lib/group-pricing.ts resolveSymbolPricing):  GroupSymbolConfig > BrokerSymbol (an account row is ignored)
//   pricing engine on  (lib/pricing-engine.ts resolvePricingV2):     AccountSymbolConfig > GroupSymbolConfig > BrokerSymbol
// D4: no account-type level (AccountType.commissionPerLot is read-only history; nothing resolves it).
// charge = commissionPerLot x volume, unrounded (lib/group-pricing.ts chargeCommission); a charge <= 0 writes nothing.
type CommLvl = { commissionPerLot: string | null } | null;
export type CommissionInput = { name: string; pricingEngineEnabled: boolean; broker: string; group: CommLvl; accountSymbol: CommLvl; volume: string };
export type PriceInput = { name: string; rule: { mode: "markup"; markupPips: string } | { mode: "target"; targetPips: string; fallbackPips: string | null }; digits: number; bid: string; ask: string };

const D = (v: string) => new Prisma.Decimal(v);
const lvl = (l: Lvl) =>
  l ? { spreadMarkup: l.spreadMarkup == null ? null : D(l.spreadMarkup), targetTotalSpreadPips: l.targetTotalSpreadPips == null ? null : D(l.targetTotalSpreadPips), commissionPerLot: null, swapLong: null, swapShort: null } : null;

/** The commission a fill charges per lot, as lib/pricing-engine.ts resolveFillPricing resolves it (the DB-free core). */
export function resolveCommission(i: CommissionInput): Prisma.Decimal {
  const c = (l: CommLvl) => (l?.commissionPerLot == null ? null : D(l.commissionPerLot));
  if (!i.pricingEngineEnabled) return c(i.group) ?? D(i.broker);
  const lv = (l: CommLvl) => (l ? { spreadMarkup: null, targetTotalSpreadPips: null, commissionPerLot: c(l), swapLong: null, swapShort: null } : null);
  return resolvePricingV2({
    accountSymbolConfig: lv(i.accountSymbol),
    groupSymbolConfig: lv(i.group),
    brokerSpreadMarkup: D("0"),
    brokerCommissionPerLot: D(i.broker),
    brokerSwapLong: D("0"),
    brokerSwapShort: D("0"),
    accountSwapFree: null,
    groupSwapFree: null,
  }).commissionPerLot;
}

/** The resolution rule, as lib/ask-markup.ts loadAskRules applies it to one pair (the DB-free core). */
export function resolveRule(i: ResolutionInput): AskRule {
  if (i.coverage) return { mode: "markup", markupPips: D("0"), digits: i.digits };
  if (!i.pricingEngineEnabled) {
    const g = i.group?.spreadMarkup;
    return { mode: "markup", markupPips: g != null ? D(g) : D(i.broker), digits: i.digits };
  }
  const resolved = resolvePricingV2({
    accountSymbolConfig: lvl(i.accountSymbol),
    groupSymbolConfig: lvl(i.group),
    brokerSpreadMarkup: D(i.broker),
    brokerCommissionPerLot: D("0"),
    brokerSwapLong: D("0"),
    brokerSwapShort: D("0"),
    accountSwapFree: null,
    groupSwapFree: null,
  });
  return askRuleFromSpread(resolved.spread, i.digits);
}

const ruleJson = (r: AskRule) =>
  r.mode === "markup" ? { mode: "markup", markupPips: r.markupPips.toString() } : { mode: "target", targetPips: r.targetPips.toString(), fallbackPips: r.fallbackPips?.toString() ?? null };

const none: Lvl = null;
const m = (x: string): Lvl => ({ spreadMarkup: x, targetTotalSpreadPips: null });
const t = (x: string, fb: string | null = null): Lvl => ({ spreadMarkup: fb, targetTotalSpreadPips: x });
const base = { coverage: false, digits: 2, broker: "0.5", group: none, accountSymbol: none };

export const RESOLUTION_INPUTS: ResolutionInput[] = [
  { ...base, name: "engine off: broker default", pricingEngineEnabled: false },
  { ...base, name: "engine off: group markup wins (Futurix Standard XAUUSD +1.5 pips)", pricingEngineEnabled: false, group: m("1.5") },
  { ...base, name: "engine off: group row with a null markup falls through to the broker", pricingEngineEnabled: false, group: { spreadMarkup: null, targetTotalSpreadPips: "3" } },
  { ...base, name: "engine off: a target on the group is ignored (flag-off fill never reads it)", pricingEngineEnabled: false, group: t("3", "1") },
  { ...base, name: "engine off: account-level config is ignored", pricingEngineEnabled: false, group: m("1.5"), accountSymbol: m("9") },
  { ...base, name: "engine on: broker default", pricingEngineEnabled: true },
  { ...base, name: "engine on: group markup", pricingEngineEnabled: true, group: m("1.5") },
  { ...base, name: "engine on: group target, with its own fallback", pricingEngineEnabled: true, group: t("3", "1") },
  { ...base, name: "engine on: account symbol config beats the group", pricingEngineEnabled: true, group: m("1.5"), accountSymbol: m("0.2") },
  { ...base, name: "engine on: a level with both nulls does not win", pricingEngineEnabled: true, group: m("1.5"), accountSymbol: { spreadMarkup: null, targetTotalSpreadPips: null } },
  { ...base, name: "coverage account: always raw", pricingEngineEnabled: true, coverage: true, group: m("1.5"), accountSymbol: m("3") },
  { ...base, name: "5-digit FX group markup", pricingEngineEnabled: false, digits: 5, broker: "0", group: m("1.2") },
];

const cl = (x: string | null): CommLvl => ({ commissionPerLot: x });
const cbase = { broker: "7", group: null as CommLvl, accountSymbol: null as CommLvl, volume: "0.01" };
// mirrors lib/pricing-engine.test.ts's commission fallthrough coverage, for both engine-flag states
export const COMMISSION_INPUTS: CommissionInput[] = [
  { ...cbase, name: "commission, engine off: broker only", pricingEngineEnabled: false },
  { ...cbase, name: "commission, engine off: group overrides broker (the 0.10 case: 10 per lot x 0.01)", pricingEngineEnabled: false, broker: "0", group: cl("10") },
  { ...cbase, name: "commission, engine off: group row with a null commission falls through to the broker", pricingEngineEnabled: false, group: cl(null) },
  { ...cbase, name: "commission, engine off: an explicit 0 on the group is honoured (not unset)", pricingEngineEnabled: false, group: cl("0") },
  { ...cbase, name: "commission, engine off: account-symbol config is ignored", pricingEngineEnabled: false, group: cl("2.5"), accountSymbol: cl("1") },
  { ...cbase, name: "commission, engine on: broker only", pricingEngineEnabled: true },
  { ...cbase, name: "commission, engine on: group overrides broker", pricingEngineEnabled: true, group: cl("2.5") },
  { ...cbase, name: "commission, engine on: group row with a null commission falls through to the broker", pricingEngineEnabled: true, group: cl(null) },
  { ...cbase, name: "commission, engine on: account-symbol overrides group", pricingEngineEnabled: true, group: cl("2.5"), accountSymbol: cl("1") },
  { ...cbase, name: "commission, engine on: account-symbol null falls through to the group", pricingEngineEnabled: true, group: cl("2.5"), accountSymbol: cl(null) },
  { ...cbase, name: "commission, engine on: account-symbol null and group null fall through to the broker", pricingEngineEnabled: true, group: cl(null), accountSymbol: cl(null) },
  { ...cbase, name: "commission, engine on: an explicit 0 on the account-symbol beats the group (VIP zero, not unset)", pricingEngineEnabled: true, group: cl("2"), accountSymbol: cl("0") },
  { ...cbase, name: "commission, engine on: account-symbol over broker with no group row", pricingEngineEnabled: true, accountSymbol: cl("3.5"), volume: "1.25" },
];

export const PRICE_INPUTS: PriceInput[] = [
  { name: "EURUSD +0.1 pips (Futurix Pro): one point, ask only", rule: { mode: "markup", markupPips: "0.1" }, digits: 5, bid: "1.12270", ask: "1.12271" },
  { name: "EURUSD +0.2 pips (Futurix Standard): one point each side", rule: { mode: "markup", markupPips: "0.2" }, digits: 5, bid: "1.12270", ask: "1.12271" },
  { name: "XAUUSD +0.1 pips (Futurix Pro)", rule: { mode: "markup", markupPips: "0.1" }, digits: 2, bid: "4089.87", ask: "4090.01" },
  { name: "XAUUSD +1.2 pips (Futurix Standard)", rule: { mode: "markup", markupPips: "1.2" }, digits: 2, bid: "4089.87", ask: "4090.01" },
  { name: "not a whole point: 0.15 pips on 5 digits rounds up to 2 points", rule: { mode: "markup", markupPips: "0.15" }, digits: 5, bid: "1.12270", ask: "1.12271" },
  { name: "XAUUSD +1.5 pips (Futurix Standard)", rule: { mode: "markup", markupPips: "1.5" }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "raw (no markup)", rule: { mode: "markup", markupPips: "0" }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "EURUSD +1.2 pips", rule: { mode: "markup", markupPips: "1.2" }, digits: 5, bid: "1.15461", ask: "1.15470" },
  { name: "US30 +1.5 (1-digit index, pip = 1)", rule: { mode: "markup", markupPips: "1.5" }, digits: 1, bid: "52496.4", ask: "52498.4" },
  { name: "BTCUSD +5 (1 digit)", rule: { mode: "markup", markupPips: "5" }, digits: 1, bid: "78981.3", ask: "78996.3" },
  { name: "target 3 pips over a 1.7-pip raw spread: +1.3", rule: { mode: "target", targetPips: "3", fallbackPips: null }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "target below the raw spread: floored at 0 (raw ask)", rule: { mode: "target", targetPips: "1", fallbackPips: "0.5" }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "target equal to the raw spread: 0", rule: { mode: "target", targetPips: "1.7", fallbackPips: null }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "EURUSD target 0.8 over a 0.3-pip raw spread", rule: { mode: "target", targetPips: "0.8", fallbackPips: null }, digits: 5, bid: "1.15461", ask: "1.15464" },
  // 2026-11-09 NEGATIVE markup (raw / zero-spread groups): client spread = max(0, raw + markup); at 0 or crossed both sides = the raw mid, ROUND HALF TO EVEN
  { name: "negative: floor to 0, half-tick mid rounds half to EVEN, down (1.122705 -> 1.12270)", rule: { mode: "markup", markupPips: "-0.5" }, digits: 5, bid: "1.12270", ask: "1.12271" },
  { name: "negative: floor to 0, half-tick mid rounds half to EVEN, up (1.122715 -> 1.12272)", rule: { mode: "markup", markupPips: "-0.5" }, digits: 5, bid: "1.12271", ask: "1.12272" },
  { name: "negative: raw 15 points + markup -13 -> spread 2 (ask -6, bid +7)", rule: { mode: "markup", markupPips: "-1.3" }, digits: 2, bid: "4089.87", ask: "4090.02" },
  { name: "negative: markup equal to the raw spread -> 0 at the mid (4089.935 -> 4089.94, half to even)", rule: { mode: "markup", markupPips: "-1.3" }, digits: 2, bid: "4089.87", ask: "4090.00" },
];

export function computeAskMarkupVectors() {
  return {
    note:
      "Generated by scripts/contracts/gen-ask-markup-vectors.ts from lib/ask-markup.ts. Do not edit by hand. " +
      "Prices are decimal strings; pip = 10^-(digits-1) (digits 0/1: 1). WHOLE-POINT SPLIT (owner decision 2026-11-06, " +
      "replaces rounding each half outward): the markup in points of the last digit, rounded up only if not whole, is " +
      "split with the ask taking the larger share: askPart = ceil(points/2), bidPart = the rest. accountAsk = raw_ask + " +
      "askPart, accountBid = raw_bid - bidPart, so the total spread is exactly raw + markup; never tighter than raw and " +
      "never at or below zero. A BUY opens at accountAsk and CLOSES AT accountBid; a SELL opens at accountBid and closes " +
      "at accountAsk. The wire carries askMarkup (add to the raw ask) and bidMarkup (subtract from the raw bid). " +
      "NEGATIVE MARKUP (2026-11-09, raw / zero-spread groups; markup >= 0 is unchanged): the same split with a negative total " +
      "(askPart = ceil(points/2), bidPart = the rest, both <= 0), so the spread narrows by exactly the markup: candidate ask = " +
      "raw_ask + askPart rounded up, candidate bid = raw_bid - bidPart rounded down. Client spread = max(0, raw + markup): when " +
      "candidate bid >= candidate ask, accountBid = accountAsk = (raw_bid + raw_ask) / 2 at the symbol's precision, ROUND HALF " +
      "TO EVEN. The wire carries the negative askMarkup / bidMarkup; a client applies the same floor. " +
      "COMMISSION RESOLUTION (2026-11-10): per field, a null falls through even when the row exists. Pricing engine OFF: " +
      "GroupSymbolConfig.commissionPerLot > BrokerSymbol.commissionPerLot (an AccountSymbolConfig row is ignored). Pricing " +
      "engine ON: AccountSymbolConfig > GroupSymbolConfig > BrokerSymbol. An explicit 0 is a real zero. No account-type level " +
      "(D4: AccountType.commissionPerLot is not resolved). charge = commissionPerLot x volume, unrounded; a charge <= 0 is not written.",
    resolution: RESOLUTION_INPUTS.map((i) => ({ ...i, expected: ruleJson(resolveRule(i)) })),
    commissionResolution: COMMISSION_INPUTS.map((i) => {
      const perLot = resolveCommission(i);
      return { ...i, expected: { commissionPerLot: perLot.toString(), charge: perLot.mul(D(i.volume)).toString() } };
    }),
    prices: PRICE_INPUTS.map((p) => {
      const rule: AskRule = p.rule.mode === "markup"
        ? { mode: "markup", markupPips: D(p.rule.markupPips), digits: p.digits }
        : { mode: "target", targetPips: D(p.rule.targetPips), fallbackPips: p.rule.fallbackPips == null ? null : D(p.rule.fallbackPips), digits: p.digits };
      return {
        ...p,
        expected: {
          markupPips: markupPipsAt(rule, p.bid, p.ask).toString(),
          askPart: markupParts(rule, p.bid, p.ask).ask.toString(),
          bidPart: markupParts(rule, p.bid, p.ask).bid.toString(),
          accountBid: markedDownBid(rule, p.bid, p.ask).toString(),
          accountAsk: markedUpAsk(rule, p.bid, p.ask).toString(),
          buyClose: accountClosePrice("BUY", p.bid, p.ask, rule).toString(),
          sellClose: accountClosePrice("SELL", p.bid, p.ask, rule).toString(),
          wire: askRuleWire(rule, p.bid, p.ask),
        },
      };
    }),
  };
}
