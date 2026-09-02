import { describe, it, expect } from "vitest";
import { currenciesForSymbol, filterEventsForSymbol, nextHighImpactEventWithin, type CalendarEvent } from "@/lib/economic-calendar";

describe("currenciesForSymbol", () => {
  it("splits a plain forex pair into base+quote", () => {
    expect(currenciesForSymbol("EURUSD")).toEqual(["EUR", "USD"]);
    expect(currenciesForSymbol("GBPJPY")).toEqual(["GBP", "JPY"]);
  });

  it("resolves metals/crypto to their trailing quote currency", () => {
    expect(currenciesForSymbol("XAUUSD")).toEqual(["USD"]);
    expect(currenciesForSymbol("BTCUSD")).toEqual(["USD"]);
    expect(currenciesForSymbol("XAUEUR")).toEqual(["EUR"]);
  });

  it("maps index symbols with no currency in their name", () => {
    expect(currenciesForSymbol("US30")).toEqual(["USD"]);
    expect(currenciesForSymbol("UK100")).toEqual(["GBP"]);
    expect(currenciesForSymbol("GER40")).toEqual(["EUR"]);
  });

  it("falls back to USD for an unrecognized symbol", () => {
    expect(currenciesForSymbol("SpotBrent")).toEqual(["USD"]);
  });
});

const mkEvent = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  time: "2026-09-02T12:00:00Z",
  country: "United States",
  event: "Test event",
  impact: "high",
  actual: null,
  estimate: null,
  previous: null,
  ...overrides,
});

describe("filterEventsForSymbol", () => {
  it("matches events by country alias against the symbol's currencies", () => {
    const events = [
      mkEvent({ country: "United States", event: "US event" }),
      mkEvent({ country: "Euro Area", event: "EU event" }),
      mkEvent({ country: "Japan", event: "JP event" }),
    ];
    const matched = filterEventsForSymbol(events, "EURUSD");
    expect(matched.map((e) => e.event)).toEqual(["US event", "EU event"]);
  });

  it("returns nothing for a currency with no matching events", () => {
    const events = [mkEvent({ country: "Japan" })];
    expect(filterEventsForSymbol(events, "EURUSD")).toEqual([]);
  });
});

describe("nextHighImpactEventWithin", () => {
  const now = new Date("2026-09-02T12:00:00Z");

  it("finds a high-impact event within the window", () => {
    const events = [mkEvent({ time: "2026-09-02T12:10:00Z", impact: "high" })];
    expect(nextHighImpactEventWithin(events, now, 15)?.time).toBe("2026-09-02T12:10:00Z");
  });

  it("ignores events outside the window", () => {
    const events = [mkEvent({ time: "2026-09-02T12:20:00Z", impact: "high" })];
    expect(nextHighImpactEventWithin(events, now, 15)).toBeNull();
  });

  it("ignores past events", () => {
    const events = [mkEvent({ time: "2026-09-02T11:59:00Z", impact: "high" })];
    expect(nextHighImpactEventWithin(events, now, 15)).toBeNull();
  });

  it("ignores non-high-impact events", () => {
    const events = [mkEvent({ time: "2026-09-02T12:10:00Z", impact: "medium" })];
    expect(nextHighImpactEventWithin(events, now, 15)).toBeNull();
  });

  it("returns the soonest of multiple qualifying events", () => {
    const events = [
      mkEvent({ time: "2026-09-02T12:14:00Z", event: "later" }),
      mkEvent({ time: "2026-09-02T12:05:00Z", event: "sooner" }),
    ];
    expect(nextHighImpactEventWithin(events, now, 15)?.event).toBe("sooner");
  });
});
