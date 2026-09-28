import { describe, expect, it } from "vitest";
import { tradingWeekStart } from "@/lib/trading-day";

// Phase 2 batch 9 (issue 363): the broker week starts at the broker day that is its Monday (Sunday 21:00 UTC in
// summer, 22:00 UTC in winter for a GMT+3 / GMT+2 server).
describe("tradingWeekStart", () => {
  it("summer: a Wednesday day start maps back to Sunday 21:00 UTC", () => {
    expect(tradingWeekStart(new Date("2026-09-29T21:00:00Z")).toISOString()).toBe("2026-09-27T21:00:00.000Z");
  });
  it("the Monday day itself is the week start", () => {
    expect(tradingWeekStart(new Date("2026-09-27T21:00:00Z")).toISOString()).toBe("2026-09-27T21:00:00.000Z");
  });
  it("winter: Friday's day (Thursday 22:00 UTC) maps back to Sunday 22:00 UTC", () => {
    expect(tradingWeekStart(new Date("2026-11-26T22:00:00Z")).toISOString()).toBe("2026-11-22T22:00:00.000Z");
  });
});
