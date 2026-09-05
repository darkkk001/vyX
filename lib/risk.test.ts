import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { checkPriceFreshness, checkSlippage, checkTradingSession, computeNextSessionOpen, evaluateLiveMarketPrice, isDefaultFxSessionClosed } from "@/lib/risk";

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

// Companion to checkTradingSession -- the incident this closes: a trader
// closing a position (or modifying SL/TP) outside trading hours saw "No
// live feed for this symbol" (checkLiveMarketPrice's own generic
// message, since position close never called checkTradingSession at all
// before this), or -- once wired up -- a MARKET_CLOSED message that
// always hardcoded "opens Sun 22:00 UTC" regardless of the symbol's own
// real configured sessions. Dates match checkTradingSession's own test
// dates above exactly, so "Fri"/"Sat"/"Sun" here are the same real days.
describe("computeNextSessionOpen", () => {
  it("default rule: closed Friday 22:30 UTC -> reopens the same week's Sunday 22:00 UTC", () => {
    const result = computeNextSessionOpen([], new Date(Date.UTC(2026, 8, 4, 22, 30)));
    expect(result.toISOString()).toBe(new Date(Date.UTC(2026, 8, 6, 22, 0, 0, 0)).toISOString());
  });

  it("default rule: closed Saturday 12:00 UTC -> reopens the same week's Sunday 22:00 UTC", () => {
    const result = computeNextSessionOpen([], new Date(Date.UTC(2026, 8, 5, 12, 0)));
    expect(result.toISOString()).toBe(new Date(Date.UTC(2026, 8, 6, 22, 0, 0, 0)).toISOString());
  });

  it("default rule: closed Sunday 21:59 UTC -> reopens later THAT SAME DAY at 22:00 UTC, not next week", () => {
    const result = computeNextSessionOpen([], new Date(Date.UTC(2026, 8, 6, 21, 59)));
    expect(result.toISOString()).toBe(new Date(Date.UTC(2026, 8, 6, 22, 0, 0, 0)).toISOString());
  });

  it("configured sessions: Wednesday-only 09:00-17:00, checked Tuesday 20:00 -> reopens Wednesday 09:00 UTC", () => {
    const sessions = [{ dayOfWeek: 3, openTime: "09:00", closeTime: "17:00" }];
    const result = computeNextSessionOpen(sessions, new Date(Date.UTC(2026, 8, 1, 20, 0))); // Tue
    expect(result.toISOString()).toBe(new Date(Date.UTC(2026, 8, 2, 9, 0, 0, 0)).toISOString()); // Wed 09:00
  });

  it("configured sessions: multiple slots the same day -- picks the earliest one still ahead of now", () => {
    const sessions = [
      { dayOfWeek: 3, openTime: "14:00", closeTime: "17:00" },
      { dayOfWeek: 3, openTime: "09:00", closeTime: "11:00" },
    ];
    const result = computeNextSessionOpen(sessions, new Date(Date.UTC(2026, 8, 2, 6, 0))); // Wed 06:00, before both
    expect(result.toISOString()).toBe(new Date(Date.UTC(2026, 8, 2, 9, 0, 0, 0)).toISOString()); // the 09:00 one, not 14:00
  });

  it("configured sessions: today's slot already passed -- skips ahead to the next valid day, not today again", () => {
    const sessions = [{ dayOfWeek: 3, openTime: "09:00", closeTime: "17:00" }]; // Wednesday only
    const result = computeNextSessionOpen(sessions, new Date(Date.UTC(2026, 8, 2, 20, 0))); // Wed 20:00, after close
    // Next Wednesday, 7 days later.
    expect(result.toISOString()).toBe(new Date(Date.UTC(2026, 8, 9, 9, 0, 0, 0)).toISOString());
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

  // The incident this pins (2026-09-05): this used to return the sentence
  // "no live feed for this symbol" directly, which close/modify displayed
  // verbatim even when the REAL reason was a routine closed market, not a
  // broken feed. Now a bare code, same convention as PRICE_STALE/
  // MARKET_CLOSED -- callers (checkTradingSession runs first) map it to a
  // "reconnecting" message only once a closed market has been ruled out.
  it("returns the bare code NO_LIVE_FEED (not a sentence) for a missing LivePrice row", () => {
    expect(evaluateLiveMarketPrice(null, "XAUUSD", "2400.00")).toBe("NO_LIVE_FEED");
  });

  it("returns NO_LIVE_FEED for a tick older than the 15s tolerance", () => {
    const livePrice = { bid: new Prisma.Decimal("2400.00"), ask: new Prisma.Decimal("2400.20"), tickAt: new Date(Date.now() - 20_000) };
    expect(evaluateLiveMarketPrice(livePrice, "XAUUSD", "2400.10")).toBe("NO_LIVE_FEED");
  });
});
