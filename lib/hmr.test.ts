import { describe, expect, it } from "vitest";
import { defaultHmrCorrelations, effectiveOpenLeverage, HMR_OFF, hmrRefusalText, positionLeverage } from "@/lib/hmr";

const sym = (name: string, baseCurrency: string, quoteCurrency: string) => ({ name, baseCurrency, quoteCurrency });

describe("HMR default correlation map (spec C2)", () => {
  const enabled = [
    sym("EURUSD", "EUR", "USD"), sym("GBPUSD", "GBP", "USD"), sym("USDJPY", "USD", "JPY"), sym("AUDNZD", "AUD", "NZD"), sym("EURGBP", "EUR", "GBP"),
    sym("XAUUSD", "XAU", "USD"), sym("XAGUSD", "XAG", "USD"), sym("USDX", "USDX", "USD"), sym("US30", "US30", "USD"), sym("NAS100", "NAS", "USD"),
    sym("GER40", "GER", "EUR"), sym("UK100", "UK", "GBP"), sym("JPN225", "JPN", "JPY"), sym("AUS200", "AUS", "AUD"), sym("USDCHF", "USD", "CHF"), sym("USDCAD", "USD", "CAD"),
  ];
  const map = defaultHmrCorrelations(enabled);
  it("USD: every enabled symbol with USD as base or quote, the metals, the dollar index and the US indices", () => {
    expect(map.USD).toEqual(["EURUSD", "GBPUSD", "NAS100", "US30", "USDCAD", "USDCHF", "USDJPY", "USDX", "XAGUSD", "XAUUSD"]);
  });
  it("EUR with GER40, GBP with UK100, JPY with JPN225, AUD with AUS200", () => {
    expect(map.EUR).toEqual(["EURGBP", "EURUSD", "GER40"]);
    expect(map.GBP).toEqual(["EURGBP", "GBPUSD", "UK100"]);
    expect(map.JPY).toEqual(["JPN225", "USDJPY"]);
    expect(map.AUD).toEqual(["AUDNZD", "AUS200"]);
    expect(map.NZD).toEqual(["AUDNZD"]);
    expect(map.CHF).toEqual(["USDCHF"]);
    expect(map.CAD).toEqual(["USDCAD"]);
  });
  it("symbols the broker has not enabled are not listed", () => {
    const small = defaultHmrCorrelations([sym("EURUSD", "EUR", "USD")]);
    expect(small.USD).toEqual(["EURUSD"]);
    expect(small.EUR).toEqual(["EURUSD"]);
    expect(small.GBP).toEqual([]);
    expect(defaultHmrCorrelations([]).USD).toEqual([]);
  });
});

describe("HMR effective leverage and refusal text", () => {
  const w = (leverage: number, from: string, to: string) => ({ id: "w", currency: "USD", startsAt: new Date(from), endsAt: new Date(to), leverage, enabled: true });
  const on = { enabled: true, windows: [w(20, "2026-11-06T13:00:00Z", "2026-11-06T14:30:00Z")], symbolsByCurrency: new Map([["USD", new Set(["XAUUSD"])]]) };
  it("min of account, group maximum and the window; stored only when it is below the account's", () => {
    const r = effectiveOpenLeverage({ accountLeverage: 500, groupMax: 500, state: on, symbol: "XAUUSD", now: new Date("2026-11-06T13:30:00Z") });
    expect(r.leverage).toBe(20);
    expect(r.openLeverage).toBe(20);
    expect(hmrRefusalText(r.hmr!)).toBe("HMR in effect for USD until 14:30 UTC: leverage 1:20 on new XAUUSD positions");
    expect(effectiveOpenLeverage({ accountLeverage: 500, groupMax: 500, state: HMR_OFF, symbol: "XAUUSD", now: new Date("2026-11-06T13:30:00Z") })).toEqual({ leverage: 500, openLeverage: null, hmr: null });
  });
  it("margin leverage of a position is openLeverage ?? account.leverage", () => {
    expect(positionLeverage({ openLeverage: 20 }, 500)).toBe(20);
    expect(positionLeverage({ openLeverage: null }, 500)).toBe(500);
    expect(positionLeverage({ openLeverage: undefined }, 100)).toBe(100);
  });
});
