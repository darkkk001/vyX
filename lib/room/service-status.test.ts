import { describe, expect, it } from "vitest";
import { SYNTH_PREFIX } from "@/lib/synthetic-symbols";
import { isWeekendClose, livePriceState, roomServiceStatus } from "./service-status";

describe("roomServiceStatus", () => {
  it("is ONLINE only when every check is OK", () => {
    expect(roomServiceStatus(["OK", "OK"])).toBe("ONLINE");
  });
  it("says AFFECTED when any check failed, even if another has no report", () => {
    expect(roomServiceStatus(["OK", "FAIL"])).toBe("AFFECTED");
    expect(roomServiceStatus(["NO_REPORT", "FAIL"])).toBe("AFFECTED");
  });
  it("claims nothing without a recent report", () => {
    expect(roomServiceStatus(["OK", "NO_REPORT"])).toBeNull();
    expect(roomServiceStatus(["NO_REPORT", "NO_REPORT"])).toBeNull();
    expect(roomServiceStatus([])).toBeNull();
  });
});

// Monday 2026-11-09 15:00 UTC = 10:00 New York, markets open
const OPEN = Date.parse("2026-11-09T15:00:00Z");
// Saturday 2026-11-07 15:00 UTC, FX week closed
const SAT = Date.parse("2026-11-07T15:00:00Z");

describe("livePriceState", () => {
  it("is OK when any real symbol ticked in the last minute", () => {
    expect(livePriceState([{ symbol: "EURUSD", last_tick_age_ms: 900_000 }, { symbol: "XAUUSD", last_tick_age_ms: 400 }], OPEN)).toBe("OK");
  });
  it("is FAIL when no real symbol ticked while markets are open (a real outage still shows)", () => {
    expect(livePriceState([{ symbol: "EURUSD", last_tick_age_ms: 120_000 }, { symbol: "BTCUSD", last_tick_age_ms: 95_000 }], OPEN)).toBe("FAIL");
  });
  it("does not count the synthetic test symbols as live prices", () => {
    expect(livePriceState([{ symbol: "EURUSD", last_tick_age_ms: 120_000 }, { symbol: `${SYNTH_PREFIX}EURUSD`, last_tick_age_ms: 10 }], OPEN)).toBe("FAIL");
    expect(livePriceState([{ symbol: `${SYNTH_PREFIX}EURUSD`, last_tick_age_ms: 10 }], OPEN)).toBe("NO_REPORT");
  });
  it("claims nothing over a weekend close or without data", () => {
    expect(livePriceState([{ symbol: "EURUSD", last_tick_age_ms: 3_600_000 }], SAT)).toBe("NO_REPORT");
    expect(livePriceState([], OPEN)).toBe("NO_REPORT");
    expect(livePriceState(null, OPEN)).toBe("NO_REPORT");
  });
});

describe("isWeekendClose", () => {
  it("covers Friday 17:00 to Sunday 17:00 New York", () => {
    expect(isWeekendClose(Date.parse("2026-11-06T21:59:00Z"))).toBe(false); // Fri 16:59 NY
    expect(isWeekendClose(Date.parse("2026-11-06T22:01:00Z"))).toBe(true); // Fri 17:01 NY
    expect(isWeekendClose(SAT)).toBe(true);
    expect(isWeekendClose(Date.parse("2026-11-08T21:59:00Z"))).toBe(true); // Sun 16:59 NY
    expect(isWeekendClose(Date.parse("2026-11-08T22:01:00Z"))).toBe(false); // Sun 17:01 NY
    expect(isWeekendClose(OPEN)).toBe(false);
  });
});
