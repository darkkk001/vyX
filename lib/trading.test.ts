import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { validateSlTp, validatePendingPriceDistance, computeRealizedPnl } from "@/lib/trading";

// Broker feedback item 13 -- lib/trading.ts had no test file at all
// despite being the one place both order-placement and position/order
// SL-TP-edit routes funnel their validation through.

describe("validateSlTp", () => {
  it("BUY: SL must be below, TP must be above the reference price", () => {
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", slPrice: "1990", tpPrice: "2010" })).toBeNull();
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", slPrice: "2010" })).toMatch(/SL must be below/);
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", slPrice: "2000" })).toMatch(/SL must be below/); // equal is invalid too
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", tpPrice: "1990" })).toMatch(/TP must be above/);
  });

  it("SELL: SL must be above, TP must be below the reference price", () => {
    expect(validateSlTp({ side: "SELL", referencePrice: "2000", slPrice: "2010", tpPrice: "1990" })).toBeNull();
    expect(validateSlTp({ side: "SELL", referencePrice: "2000", slPrice: "1990" })).toMatch(/SL must be above/);
    expect(validateSlTp({ side: "SELL", referencePrice: "2000", tpPrice: "2010" })).toMatch(/TP must be below/);
  });

  it("with no digits/stopLevel passed, the minimum-distance rule is skipped entirely (pre-existing callers keep compiling/behaving unchanged)", () => {
    // A price on the correct side but only 1 unit away -- would violate
    // any real stopLevel, but passes when the check isn't wired at all.
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", slPrice: "1999" })).toBeNull();
  });

  it("item 13's actual bug: stopLevel is enforced once digits/stopLevel are both passed", () => {
    // stopLevel=50 points on a 2-digit symbol (XAUUSD-like) = 0.50 minimum distance.
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", slPrice: "1999.60", digits: 2, stopLevel: 50 })).toMatch(/SL must be at least/);
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", slPrice: "1999.50", digits: 2, stopLevel: 50 })).toBeNull(); // exactly at the boundary is fine
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", tpPrice: "2000.40", digits: 2, stopLevel: 50 })).toMatch(/TP must be at least/);
  });

  it("stopLevel <= 0 means unrestricted, even when digits is passed", () => {
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", slPrice: "1999.99", digits: 2, stopLevel: 0 })).toBeNull();
  });

  it("null/undefined slPrice or tpPrice is simply not checked (clearing one, or never setting it)", () => {
    expect(validateSlTp({ side: "BUY", referencePrice: "2000", slPrice: null, tpPrice: null })).toBeNull();
    expect(validateSlTp({ side: "BUY", referencePrice: "2000" })).toBeNull();
  });

  it("accepts Decimal/number/string reference and target prices interchangeably", () => {
    const viaString = validateSlTp({ side: "BUY", referencePrice: "2000", slPrice: "2010" });
    const viaNumber = validateSlTp({ side: "BUY", referencePrice: 2000, slPrice: 2010 });
    const viaDecimal = validateSlTp({ side: "BUY", referencePrice: new Prisma.Decimal(2000), slPrice: new Prisma.Decimal(2010) });
    expect(viaString).toEqual(viaNumber);
    expect(viaNumber).toEqual(viaDecimal);
  });
});

describe("validatePendingPriceDistance", () => {
  it("rejects an entry price too close to the current market, on either side", () => {
    // stopLevel=100 points on a 5-digit FX pair = 0.00100 minimum distance.
    const error = validatePendingPriceDistance({ type: "LIMIT", side: "BUY", entryPrice: "1.10050", marketPrice: "1.10100", digits: 5, stopLevel: 100 });
    expect(error).toMatch(/at least/);
  });

  it("accepts an entry price far enough from the current market", () => {
    const error = validatePendingPriceDistance({ type: "LIMIT", side: "BUY", entryPrice: "1.09000", marketPrice: "1.10100", digits: 5, stopLevel: 100 });
    expect(error).toBeNull();
  });

  it("stopLevel <= 0 means unrestricted", () => {
    expect(validatePendingPriceDistance({ type: "STOP", side: "SELL", entryPrice: "1.10099", marketPrice: "1.10100", digits: 5, stopLevel: 0 })).toBeNull();
  });

  it("distance is symmetric -- doesn't care which side of the market the entry sits on", () => {
    // stopLevel=100 points on 5 digits = 0.00100 minimum -- 0.0015 clears it either direction.
    const above = validatePendingPriceDistance({ type: "STOP", side: "BUY", entryPrice: "1.10250", marketPrice: "1.10100", digits: 5, stopLevel: 100 });
    const below = validatePendingPriceDistance({ type: "LIMIT", side: "SELL", entryPrice: "1.09950", marketPrice: "1.10100", digits: 5, stopLevel: 100 });
    expect(above).toBeNull();
    expect(below).toBeNull();
  });
});

describe("computeRealizedPnl", () => {
  it("BUY profits when closePrice is above openPrice", () => {
    const pnl = computeRealizedPnl({ side: "BUY", openPrice: new Prisma.Decimal("4000"), closePrice: "4010", volume: new Prisma.Decimal("1"), contractSize: new Prisma.Decimal("100") });
    expect(pnl.toString()).toBe("1000");
  });

  it("BUY loses when closePrice is below openPrice", () => {
    const pnl = computeRealizedPnl({ side: "BUY", openPrice: new Prisma.Decimal("4000"), closePrice: "3990", volume: new Prisma.Decimal("1"), contractSize: new Prisma.Decimal("100") });
    expect(pnl.toString()).toBe("-1000");
  });

  it("SELL profits when closePrice is below openPrice (inverse of BUY)", () => {
    const pnl = computeRealizedPnl({ side: "SELL", openPrice: new Prisma.Decimal("4000"), closePrice: "3990", volume: new Prisma.Decimal("1"), contractSize: new Prisma.Decimal("100") });
    expect(pnl.toString()).toBe("1000");
  });

  it("scales linearly with volume and contract size", () => {
    const pnl = computeRealizedPnl({ side: "BUY", openPrice: new Prisma.Decimal("4000"), closePrice: "4010", volume: new Prisma.Decimal("2.5"), contractSize: new Prisma.Decimal("100") });
    expect(pnl.toString()).toBe("2500"); // 10 * 2.5 * 100
  });
});
