import { Prisma } from "@prisma/client";
import { resolvePricingV2 } from "@/lib/pricing-engine";
import { accountClosePrice, askRuleFromSpread, askRuleWire, markedUpAsk, markupPipsAt, type AskRule } from "@/lib/ask-markup";

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
  accountType: { spreadMarkup: string | null } | null; // AccountType (flat)
  accountTypeSymbol: Lvl; // AccountTypeSymbolConfig
  accountSymbol: Lvl; // AccountSymbolConfig
};
export type PriceInput = { name: string; rule: { mode: "markup"; markupPips: string } | { mode: "target"; targetPips: string; fallbackPips: string | null }; digits: number; bid: string; ask: string };

const D = (v: string) => new Prisma.Decimal(v);
const lvl = (l: Lvl) =>
  l ? { spreadMarkup: l.spreadMarkup == null ? null : D(l.spreadMarkup), targetTotalSpreadPips: l.targetTotalSpreadPips == null ? null : D(l.targetTotalSpreadPips), commissionPerLot: null, swapLong: null, swapShort: null } : null;

/** The resolution rule, as lib/ask-markup.ts loadAskRules applies it to one pair (the DB-free core). */
export function resolveRule(i: ResolutionInput): AskRule {
  if (i.coverage) return { mode: "markup", markupPips: D("0"), digits: i.digits };
  if (!i.pricingEngineEnabled) {
    const g = i.group?.spreadMarkup;
    return { mode: "markup", markupPips: g != null ? D(g) : D(i.broker), digits: i.digits };
  }
  const resolved = resolvePricingV2({
    accountSymbolConfig: lvl(i.accountSymbol),
    accountTypeSymbolConfig: lvl(i.accountTypeSymbol),
    accountType: i.accountType ? { spreadMarkup: i.accountType.spreadMarkup == null ? null : D(i.accountType.spreadMarkup), commissionPerLot: null, swapLong: null, swapShort: null, swapFree: null } : null,
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
const base = { coverage: false, digits: 2, broker: "0.5", group: none, accountType: null, accountTypeSymbol: none, accountSymbol: none };

export const RESOLUTION_INPUTS: ResolutionInput[] = [
  { ...base, name: "engine off: broker default", pricingEngineEnabled: false },
  { ...base, name: "engine off: group markup wins (Futurix Standard XAUUSD +1.5 pips)", pricingEngineEnabled: false, group: m("1.5") },
  { ...base, name: "engine off: group row with a null markup falls through to the broker", pricingEngineEnabled: false, group: { spreadMarkup: null, targetTotalSpreadPips: "3" } },
  { ...base, name: "engine off: a target on the group is ignored (flag-off fill never reads it)", pricingEngineEnabled: false, group: t("3", "1") },
  { ...base, name: "engine off: account-level config is ignored", pricingEngineEnabled: false, group: m("1.5"), accountSymbol: m("9") },
  { ...base, name: "engine on: broker default", pricingEngineEnabled: true },
  { ...base, name: "engine on: group markup", pricingEngineEnabled: true, group: m("1.5") },
  { ...base, name: "engine on: group target, with its own fallback", pricingEngineEnabled: true, group: t("3", "1") },
  { ...base, name: "engine on: account type flat markup beats the group", pricingEngineEnabled: true, group: t("3", "1"), accountType: { spreadMarkup: "2" } },
  { ...base, name: "engine on: account type symbol target beats the flat type", pricingEngineEnabled: true, accountType: { spreadMarkup: "2" }, accountTypeSymbol: t("2.5") },
  { ...base, name: "engine on: account symbol config beats everything", pricingEngineEnabled: true, group: m("1.5"), accountType: { spreadMarkup: "2" }, accountTypeSymbol: t("2.5"), accountSymbol: m("0.2") },
  { ...base, name: "engine on: a level with both nulls does not win", pricingEngineEnabled: true, group: m("1.5"), accountSymbol: { spreadMarkup: null, targetTotalSpreadPips: null } },
  { ...base, name: "coverage account: always raw", pricingEngineEnabled: true, coverage: true, group: m("1.5"), accountSymbol: m("3") },
  { ...base, name: "5-digit FX group markup", pricingEngineEnabled: false, digits: 5, broker: "0", group: m("1.2") },
];

export const PRICE_INPUTS: PriceInput[] = [
  { name: "XAUUSD +1.5 pips (Futurix Standard)", rule: { mode: "markup", markupPips: "1.5" }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "raw (no markup)", rule: { mode: "markup", markupPips: "0" }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "EURUSD +1.2 pips", rule: { mode: "markup", markupPips: "1.2" }, digits: 5, bid: "1.15461", ask: "1.15470" },
  { name: "US30 +1.5 (1-digit index, pip = 1)", rule: { mode: "markup", markupPips: "1.5" }, digits: 1, bid: "52496.4", ask: "52498.4" },
  { name: "BTCUSD +5 (1 digit)", rule: { mode: "markup", markupPips: "5" }, digits: 1, bid: "78981.3", ask: "78996.3" },
  { name: "target 3 pips over a 1.7-pip raw spread: +1.3", rule: { mode: "target", targetPips: "3", fallbackPips: null }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "target below the raw spread: floored at 0 (raw ask)", rule: { mode: "target", targetPips: "1", fallbackPips: "0.5" }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "target equal to the raw spread: 0", rule: { mode: "target", targetPips: "1.7", fallbackPips: null }, digits: 2, bid: "4298.96", ask: "4299.13" },
  { name: "EURUSD target 0.8 over a 0.3-pip raw spread", rule: { mode: "target", targetPips: "0.8", fallbackPips: null }, digits: 5, bid: "1.15461", ask: "1.15464" },
];

export function computeAskMarkupVectors() {
  return {
    note: "Generated by scripts/contracts/gen-ask-markup-vectors.ts from lib/ask-markup.ts. Do not edit by hand. Prices are decimal strings; pip = 10^-(digits-1) (digits 0/1: 1). A BUY closes at the raw bid; a SELL closes at the account's ask; the bid is never marked up.",
    resolution: RESOLUTION_INPUTS.map((i) => ({ ...i, expected: ruleJson(resolveRule(i)) })),
    prices: PRICE_INPUTS.map((p) => {
      const rule: AskRule = p.rule.mode === "markup"
        ? { mode: "markup", markupPips: D(p.rule.markupPips), digits: p.digits }
        : { mode: "target", targetPips: D(p.rule.targetPips), fallbackPips: p.rule.fallbackPips == null ? null : D(p.rule.fallbackPips), digits: p.digits };
      return {
        ...p,
        expected: {
          markupPips: markupPipsAt(rule, p.bid, p.ask).toString(),
          accountAsk: markedUpAsk(rule, p.bid, p.ask).toString(),
          buyClose: accountClosePrice("BUY", p.bid, p.ask, rule).toString(),
          sellClose: accountClosePrice("SELL", p.bid, p.ask, rule).toString(),
          wire: askRuleWire(rule, p.bid, p.ask),
        },
      };
    }),
  };
}
