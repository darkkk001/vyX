import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { conversionRate, conversionSymbolsFor, type FxLookup } from "@/lib/fx";

const D = (v: string | number) => new Prisma.Decimal(v);
const book = (quotes: Record<string, [string, string]>): FxLookup => (s) => (quotes[s] ? { bid: D(quotes[s][0]), ask: D(quotes[s][1]) } : undefined);

describe("conversionRate (quote currency -> account currency)", () => {
  it("is exactly 1 for the same currency, whatever the book holds", () => {
    expect(conversionRate("USD", "usd", book({}))!.toString()).toBe("1");
  });

  it("uses the pair's mid when it is quoted from -> to (GBP -> USD via GBPUSD)", () => {
    expect(conversionRate("GBP", "USD", book({ GBPUSD: ["1.35000", "1.35020"] }))!.toString()).toBe("1.3501");
  });

  it("inverts the pair when only to -> from is quoted (JPY -> USD via USDJPY)", () => {
    const r = conversionRate("JPY", "USD", book({ USDJPY: ["149.990", "150.010"] }))!;
    expect(r.mul(150).toDecimalPlaces(10).toString()).toBe("1");
  });

  it("crosses through USD when neither direct pair exists (JPY -> EUR)", () => {
    const r = conversionRate("JPY", "EUR", book({ USDJPY: ["150", "150"], EURUSD: ["1.2", "1.2"] }))!;
    // 1 JPY = 1/150 USD = (1/150)/1.2 EUR
    expect(r.toDecimalPlaces(12).toString()).toBe(D(1).div(150).div(D("1.2")).toDecimalPlaces(12).toString());
  });

  it("returns null when there is nothing to convert with, and ignores a zero quote", () => {
    expect(conversionRate("JPY", "USD", book({}))).toBeNull();
    expect(conversionRate("JPY", "USD", book({ USDJPY: ["0", "0"] }))).toBeNull();
  });

  it("a USDJPY 1-lot 10-pip win is ~66.67 USD, not 10,000", () => {
    const pnlJpy = D("150.100").sub(D("150.000")).mul(100000).mul(1); // 10,000 JPY
    const usd = pnlJpy.mul(conversionRate("JPY", "USD", book({ USDJPY: ["150.000", "150.000"] }))!);
    expect(usd.toDecimalPlaces(2).toString()).toBe("66.67");
  });

  it("names exactly the symbols it may read", () => {
    expect(conversionSymbolsFor("USD", "USD")).toEqual([]);
    expect(conversionSymbolsFor("JPY", "USD")).toEqual(["JPYUSD", "USDJPY"]);
    expect(conversionSymbolsFor("JPY", "EUR")).toEqual(["JPYEUR", "EURJPY", "JPYUSD", "USDJPY", "EURUSD", "USDEUR"]);
  });
});
