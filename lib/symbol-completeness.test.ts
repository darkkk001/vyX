import { describe, expect, it } from "vitest";
import { missingForSymbol, symbolCompleteness, FEED_STALE_MS, type CompletenessInput } from "@/lib/symbol-completeness";

// USDX as it is in production (read-only look 2026-10-08): INDICES, 3 digits, USD/USD, contract 100, lots 0.01/100/0.01, hedged 50,
// BOTH, B_BOOK, no sessions, no group rows. Complete by the platform's own standard (US30 / NAS100 / US500 look the same).
const usdx = (): CompletenessInput => ({
  symbol: { name: "USDX", category: "INDICES", baseCurrency: "USD", quoteCurrency: "USD", digits: 3, contractSize: "100" },
  brokerSymbol: { enabled: true, minLot: "0.01", maxLot: "100", lotStep: "0.01", hedgedMarginPct: "50", tradingMode: "BOTH", defaultBookType: "B_BOOK" },
});

describe("symbol completeness", () => {
  it("a symbol shaped like production's USDX is complete (no sessions and no group rows needed)", () => {
    expect(missingForSymbol(usdx())).toEqual([]);
  });

  it("a symbol the broker has no row for is not 'incomplete'", () => {
    expect(missingForSymbol({ ...usdx(), brokerSymbol: null })).toEqual([]);
  });

  it.each([
    ["digits", (i: CompletenessInput) => { i.symbol.digits = null; }, "Price digits are not set"],
    ["digits out of range", (i: CompletenessInput) => { i.symbol.digits = 12; }, "Price digits are not set"],
    ["contract size 0", (i: CompletenessInput) => { i.symbol.contractSize = "0"; }, "Contract size is not set"],
    ["contract size missing", (i: CompletenessInput) => { i.symbol.contractSize = null; }, "Contract size is not set"],
    ["category", (i: CompletenessInput) => { i.symbol.category = ""; }, "Asset class is not set"],
    ["base currency", (i: CompletenessInput) => { i.symbol.baseCurrency = " "; }, "Base currency is not set"],
    ["quote currency", (i: CompletenessInput) => { i.symbol.quoteCurrency = null; }, "Profit currency is not set"],
    ["min lot", (i: CompletenessInput) => { i.brokerSymbol!.minLot = "0"; }, "Minimum lot is not set"],
    ["lot step", (i: CompletenessInput) => { i.brokerSymbol!.lotStep = "0"; }, "Lot step is not set"],
    ["max lot", (i: CompletenessInput) => { i.brokerSymbol!.maxLot = null; }, "Maximum lot is not set"],
    ["max below min", (i: CompletenessInput) => { i.brokerSymbol!.minLot = "5"; i.brokerSymbol!.maxLot = "1"; }, "Maximum lot is below the minimum lot"],
    ["hedged margin", (i: CompletenessInput) => { i.brokerSymbol!.hedgedMarginPct = "250"; }, "Hedged margin is not set"],
    ["sides", (i: CompletenessInput) => { i.brokerSymbol!.tradingMode = ""; }, "Allowed sides are not set"],
    ["book", (i: CompletenessInput) => { i.brokerSymbol!.defaultBookType = null; }, "Book is not set"],
  ])("names what is missing: %s", (_n, mutate, sentence) => {
    const i = usdx(); mutate(i);
    expect(missingForSymbol(i)).toContain(sentence);
  });

  it("lists every missing piece, in plain words (no field names)", () => {
    const i = usdx(); i.symbol.digits = null; i.symbol.contractSize = 0; i.brokerSymbol!.lotStep = 0;
    const m = missingForSymbol(i);
    expect(m).toEqual(["Price digits are not set", "Contract size is not set", "Lot step is not set"]);
    for (const s of m) expect(s).not.toMatch(/[a-z][A-Z]|_/);
  });

  it("the feed check only runs when the caller knows the feed's age", () => {
    expect(missingForSymbol(usdx())).toEqual([]);
    expect(missingForSymbol({ ...usdx(), feedTickAgeMs: 1000 })).toEqual([]);
    expect(missingForSymbol({ ...usdx(), feedTickAgeMs: null })).toEqual(["No price from the feed yet"]);
    expect(missingForSymbol({ ...usdx(), feedTickAgeMs: FEED_STALE_MS + 1 })).toEqual(["No price from the feed yet"]);
  });

  it("symbolCompleteness reads the broker's rows and returns only the incomplete ones", async () => {
    const good = { id: "s1", ...usdx().symbol, brokerSymbols: [usdx().brokerSymbol!] };
    const bad = { id: "s2", ...usdx().symbol, name: "BAD", digits: null, brokerSymbols: [usdx().brokerSymbol!] };
    const none = { id: "s3", ...usdx().symbol, name: "NONE", brokerSymbols: [] };
    const db = { symbol: { findMany: async () => [good, bad, none] } };
    const m = await symbolCompleteness(db, "b1");
    expect([...m.keys()]).toEqual(["s2"]);
    expect(m.get("s2")).toEqual(["Price digits are not set"]);
  });
});
