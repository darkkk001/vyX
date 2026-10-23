import { describe, expect, it } from "vitest";
import { checkTradingSession, computeNextSessionOpen, dailyBreakHours } from "@/lib/risk";

// Commodity daily break (owner 2026-10-23, option A), from two weeks of feed data: SpotCrude pauses like the metals
// (17:00-18:00 New York); SpotBrent pauses 3 hours from the same anchor. No configured session rows (the default rule).
const at = (iso: string) => new Date(iso);
const closed = (iso: string, name: string, category: "COMMODITIES" | "METALS" | "FOREX" = "COMMODITIES") => checkTradingSession([], at(iso), category, name) === "MARKET_CLOSED";

describe("commodity daily break", () => {
  it("break lengths: metals 1 h, SpotCrude 1 h, SpotBrent 3 h, others none", () => {
    expect([dailyBreakHours("METALS", "XAUUSD"), dailyBreakHours("COMMODITIES", "SpotCrude"), dailyBreakHours("COMMODITIES", "SpotBrent"), dailyBreakHours("FOREX", "EURUSD")]).toEqual([1, 1, 3, 0]);
  });

  it("summer (New York on EDT), Wednesday: matches the feed (Crude 21:00-22:00, Brent 21:00-00:00 UTC)", () => {
    expect(closed("2026-10-21T20:59:00Z", "SpotCrude")).toBe(false);
    expect(closed("2026-10-21T21:00:00Z", "SpotCrude")).toBe(true);
    expect(closed("2026-10-21T21:59:00Z", "SpotCrude")).toBe(true);
    expect(closed("2026-10-21T22:00:00Z", "SpotCrude")).toBe(false);
    expect(closed("2026-10-21T21:00:00Z", "SpotBrent")).toBe(true);
    expect(closed("2026-10-21T23:59:00Z", "SpotBrent")).toBe(true);
    expect(closed("2026-10-22T00:00:00Z", "SpotBrent")).toBe(false);
    expect(closed("2026-10-21T21:30:00Z", "XAUUSD", "METALS")).toBe(true); // the metals rule is unchanged
    expect(closed("2026-10-21T22:30:00Z", "XAUUSD", "METALS")).toBe(false);
    expect(closed("2026-10-21T21:30:00Z", "EURUSD", "FOREX")).toBe(false);
  });

  it("winter (EST): one hour later; Brent's break crosses midnight", () => {
    expect(closed("2026-11-11T21:30:00Z", "SpotCrude")).toBe(false);
    expect(closed("2026-11-11T22:30:00Z", "SpotCrude")).toBe(true);
    expect(closed("2026-11-11T23:00:00Z", "SpotCrude")).toBe(false);
    expect(closed("2026-11-11T22:00:00Z", "SpotBrent")).toBe(true);
    expect(closed("2026-11-12T00:59:00Z", "SpotBrent")).toBe(true);
    expect(closed("2026-11-12T01:00:00Z", "SpotBrent")).toBe(false);
  });

  it("Thursday night's Brent break runs into Friday; Friday has none of its own (the weekly close covers it)", () => {
    expect(closed("2026-10-22T23:30:00Z", "SpotBrent")).toBe(true);
    expect(closed("2026-10-23T00:30:00Z", "SpotBrent")).toBe(false);
    expect(closed("2026-10-23T12:00:00Z", "SpotBrent")).toBe(false);
  });

  it("the reopen time each break reports", () => {
    expect(computeNextSessionOpen([], at("2026-10-21T21:30:00Z"), "COMMODITIES", "SpotCrude").toISOString()).toBe("2026-10-21T22:00:00.000Z");
    expect(computeNextSessionOpen([], at("2026-10-21T21:30:00Z"), "COMMODITIES", "SpotBrent").toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(computeNextSessionOpen([], at("2026-11-12T00:15:00Z"), "COMMODITIES", "SpotBrent").toISOString()).toBe("2026-11-12T01:00:00.000Z");
    expect(computeNextSessionOpen([], at("2026-10-21T21:30:00Z"), "METALS", "XAUUSD").toISOString()).toBe("2026-10-21T22:00:00.000Z");
  });

  it("a broker's own session rows still win over the default rule", () => {
    const allDay = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, openTime: "00:00", closeTime: "24:00" }));
    expect(checkTradingSession(allDay, at("2026-10-21T21:30:00Z"), "COMMODITIES", "SpotBrent")).toBeNull();
  });
});
