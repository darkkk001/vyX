import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { checkPriceFreshness, checkSlippage, checkTradingSession, evaluateLiveMarketPrice, isDefaultFxSessionClosed } from "@/lib/risk";

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
    const livePrice = { tickAt: new Date(Date.now() - 5_000) };
    expect(checkPriceFreshness(livePrice)).toBe("PRICE_STALE");
  });

  it("accepts a tick within the 3s window", () => {
    const livePrice = { tickAt: new Date(Date.now() - 500) };
    expect(checkPriceFreshness(livePrice)).toBeNull();
  });

  // The exact incident this closes: updatedAt would have looked "fresh"
  // forever (bumped on every heartbeat write), but tickAt -- the real
  // last-tick time -- correctly stays old when the underlying price is
  // frozen (a real market close, or a mid-week feed outage).
  it("rejects a frozen price whose row was JUST rewritten (updatedAt fresh) but whose real tick is old", () => {
    const livePrice = { tickAt: new Date(Date.now() - 10 * 60 * 1000) }; // real tick 10 minutes old
    expect(checkPriceFreshness(livePrice)).toBe("PRICE_STALE");
  });
});

// Session-enforcement pack -- the incident this closes: a MARKET order
// filled XAUUSD while the real market was closed, because "zero
// configured TradingSession rows" meant "always tradable" (see
// checkTradingSession's own comment). Dates below are exact UTC instants
// matching the user's own test list, constructed with Date.UTC so they're
// not sensitive to the machine's local timezone running the suite.
describe("isDefaultFxSessionClosed", () => {
  it("is closed Friday 22:30 UTC", () => {
    expect(isDefaultFxSessionClosed(new Date(Date.UTC(2026, 8, 4, 22, 30)))).toBe(true); // Fri
  });
  it("is closed Saturday, any time", () => {
    expect(isDefaultFxSessionClosed(new Date(Date.UTC(2026, 8, 5, 12, 0)))).toBe(true); // Sat
  });
  it("is closed Sunday 21:59 UTC", () => {
    expect(isDefaultFxSessionClosed(new Date(Date.UTC(2026, 8, 6, 21, 59)))).toBe(true); // Sun
  });
  it("is open Sunday 22:01 UTC", () => {
    expect(isDefaultFxSessionClosed(new Date(Date.UTC(2026, 8, 6, 22, 1)))).toBe(false); // Sun
  });
  it("is open on a plain weekday", () => {
    expect(isDefaultFxSessionClosed(new Date(Date.UTC(2026, 8, 2, 12, 0)))).toBe(false); // Wed
  });
});

describe("checkTradingSession", () => {
  it("rejects a MARKET-style check at Fri 22:30 UTC with no configured sessions (the actual incident)", () => {
    expect(checkTradingSession([], new Date(Date.UTC(2026, 8, 4, 22, 30)), "XAUUSD")).toBe("MARKET_CLOSED");
  });
  it("rejects at Sun 21:59 UTC", () => {
    expect(checkTradingSession([], new Date(Date.UTC(2026, 8, 6, 21, 59)), "XAUUSD")).toBe("MARKET_CLOSED");
  });
  it("accepts at Sun 22:01 UTC", () => {
    expect(checkTradingSession([], new Date(Date.UTC(2026, 8, 6, 22, 1)), "XAUUSD")).toBeNull();
  });
  it("accepts BTCUSD at any time, including deep in the weekend closure", () => {
    expect(checkTradingSession([], new Date(Date.UTC(2026, 8, 5, 12, 0)), "BTCUSD")).toBeNull();
  });
  it("accepts ETHUSD at any time too", () => {
    expect(checkTradingSession([], new Date(Date.UTC(2026, 8, 5, 12, 0)), "ETHUSD")).toBeNull();
  });
  it("an explicit configured session overrides the default -- open outside the default window if the row says so", () => {
    const sessions = [{ dayOfWeek: 6, openTime: "00:00", closeTime: "23:59" }]; // Saturday, all day
    expect(checkTradingSession(sessions, new Date(Date.UTC(2026, 8, 5, 12, 0)), "XAUUSD")).toBeNull();
  });
  it("an explicit configured session still rejects outside its own window", () => {
    const sessions = [{ dayOfWeek: 3, openTime: "09:00", closeTime: "17:00" }]; // Wednesday only
    expect(checkTradingSession(sessions, new Date(Date.UTC(2026, 8, 2, 20, 0)), "XAUUSD")).toBe("MARKET_CLOSED");
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
    const livePrice = { bid: new Prisma.Decimal("2400.00"), ask: new Prisma.Decimal("2400.20"), tickAt: new Date() };
    const result = evaluateLiveMarketPrice(livePrice, "XAUUSD", "1.00");
    expect(result).not.toBeNull();
  });
});
