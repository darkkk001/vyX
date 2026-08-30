import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { checkPriceFreshness, checkSlippage, evaluateLiveMarketPrice } from "@/lib/risk";

// Phase 0 money-risk patch (docs/ROADMAP.md item 1) -- the exploit this
// closes: a client could submit any price for a MARKET order and it
// filled at that price verbatim (or, for a resting LIMIT/STOP order,
// whatever price its client-side trigger detection reported), letting an
// authenticated trader mint arbitrary profit against a stale or
// fabricated price. These tests pin the new gates that make that
// impossible: a stale feed rejects outright (checkPriceFreshness), and a
// fill that lands too far from what the client expected rejects too
// (checkSlippage) even though the server -- not the client -- now
// chooses the actual fill price.

describe("checkPriceFreshness", () => {
  it("rejects a null LivePrice row (no feed) as PRICE_STALE", () => {
    expect(checkPriceFreshness(null)).toBe("PRICE_STALE");
  });

  it("rejects a tick older than 3s as PRICE_STALE", () => {
    const livePrice = { updatedAt: new Date(Date.now() - 5_000) };
    expect(checkPriceFreshness(livePrice)).toBe("PRICE_STALE");
  });

  it("accepts a tick within the 3s window", () => {
    const livePrice = { updatedAt: new Date(Date.now() - 500) };
    expect(checkPriceFreshness(livePrice)).toBeNull();
  });
});

describe("checkSlippage", () => {
  // lib/group-pricing.ts's pipSize(2) = 0.1 (exp = digits-1 = 1) -- same
  // convention engine/order-management/src/pricing.rs uses, kept in sync
  // deliberately. Default tolerance is 5 pips = 0.5 price units here.
  const digits = 2;

  it("accepts a fill within the default 5-pip tolerance", () => {
    const result = checkSlippage({
      clientReferencePrice: "2400.00",
      serverFillPrice: new Prisma.Decimal("2400.30"), // 3 pips
      maxSlippagePips: null,
      digits,
    });
    expect(result).toBeNull();
  });

  it("rejects a fill beyond the default tolerance as SLIPPAGE_EXCEEDED", () => {
    const result = checkSlippage({
      clientReferencePrice: "2400.00",
      serverFillPrice: new Prisma.Decimal("2400.60"), // 6 pips
      maxSlippagePips: null,
      digits,
    });
    expect(result).toBe("SLIPPAGE_EXCEEDED");
  });

  it("honors a caller-supplied maxSlippagePips instead of the default", () => {
    const withinCustomTolerance = checkSlippage({
      clientReferencePrice: "2400.00",
      serverFillPrice: new Prisma.Decimal("2400.60"), // 6 pips
      maxSlippagePips: "20", // tolerance = 2.0
      digits,
    });
    expect(withinCustomTolerance).toBeNull();

    const beyondCustomTolerance = checkSlippage({
      clientReferencePrice: "2400.00",
      serverFillPrice: new Prisma.Decimal("2400.60"), // 6 pips
      maxSlippagePips: "2", // tolerance = 0.2
      digits,
    });
    expect(beyondCustomTolerance).toBe("SLIPPAGE_EXCEEDED");
  });
});

describe("evaluateLiveMarketPrice (existing coarse sanity check, still runs alongside the new gates)", () => {
  it("still rejects a client price fabricated far from the live mid", () => {
    const livePrice = { bid: new Prisma.Decimal("2400.00"), ask: new Prisma.Decimal("2400.20"), updatedAt: new Date() };
    const result = evaluateLiveMarketPrice(livePrice, "XAUUSD", "1.00");
    expect(result).not.toBeNull();
  });
});
