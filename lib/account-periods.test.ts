import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/account-summary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-summary")>()),
  summarizeAccount: vi.fn(),
}));

import { realizedPeriods, tradingPeriodStarts } from "@/lib/account-periods";
import { summarizeAccount } from "@/lib/account-summary";

const at = (s: string) => new Date(s);
const iso = (d: Date) => d.toISOString();

describe("tradingPeriodStarts: New York 17:00 day, Sunday 17:00 week", () => {
  it("summer (EDT): the day starts 21:00 UTC; before it, the previous evening's", () => {
    // Tue 27 Oct 2026 (US still on EDT until 1 Nov)
    expect(iso(tradingPeriodStarts(at("2026-10-27T12:00:00Z")).dayStart)).toBe("2026-10-26T21:00:00.000Z");
    expect(iso(tradingPeriodStarts(at("2026-10-27T21:00:00Z")).dayStart)).toBe("2026-10-27T21:00:00.000Z");
    expect(iso(tradingPeriodStarts(at("2026-10-27T20:59:59Z")).dayStart)).toBe("2026-10-26T21:00:00.000Z");
    // the week started at Sunday 25 Oct 21:00 UTC
    expect(iso(tradingPeriodStarts(at("2026-10-27T12:00:00Z")).weekStart)).toBe("2026-10-25T21:00:00.000Z");
  });

  it("winter (EST): 22:00 UTC", () => {
    expect(iso(tradingPeriodStarts(at("2026-11-11T23:30:00Z")).dayStart)).toBe("2026-11-11T22:00:00.000Z");
    expect(iso(tradingPeriodStarts(at("2026-11-11T21:30:00Z")).dayStart)).toBe("2026-11-10T22:00:00.000Z");
    expect(iso(tradingPeriodStarts(at("2026-11-11T21:30:00Z")).weekStart)).toBe("2026-11-08T22:00:00.000Z");
  });

  it("Sunday: before the week opens the previous week still runs; at the open both day and week start", () => {
    expect(iso(tradingPeriodStarts(at("2026-10-25T20:00:00Z")).weekStart)).toBe("2026-10-18T21:00:00.000Z");
    const open = tradingPeriodStarts(at("2026-10-25T21:00:00Z"));
    expect(iso(open.weekStart)).toBe("2026-10-25T21:00:00.000Z");
    expect(iso(open.dayStart)).toBe("2026-10-25T21:00:00.000Z");
  });

  it("the DST switch weekend: the Sunday 1 Nov week opens at 22:00 UTC (EST), the Friday before closed at 21:00", () => {
    expect(iso(tradingPeriodStarts(at("2026-11-02T10:00:00Z")).weekStart)).toBe("2026-11-01T22:00:00.000Z");
    expect(iso(tradingPeriodStarts(at("2026-10-30T21:30:00Z")).dayStart)).toBe("2026-10-30T21:00:00.000Z");
  });
});

describe("realizedPeriods", () => {
  it("is the account summary's trades.netPnl over [dayStart, now] and [weekStart, now], with the boundaries stated", async () => {
    const mk = (net: string, count: number) => ({ trades: { count, grossPnl: "100.00", commission: "3.00", swap: "1.50", netPnl: net } });
    vi.mocked(summarizeAccount).mockReset();
    vi.mocked(summarizeAccount)
      .mockResolvedValueOnce(mk("12.34", 2) as never)
      .mockResolvedValueOnce(mk("810.58", 9) as never);
    const now = at("2026-10-27T12:00:00Z");
    const r = await realizedPeriods("acc1", { brokerId: "b1" }, now);
    expect(vi.mocked(summarizeAccount).mock.calls).toEqual([
      ["acc1", { from: at("2026-10-26T21:00:00Z"), to: now }, { brokerId: "b1" }],
      ["acc1", { from: at("2026-10-25T21:00:00Z"), to: now }, { brokerId: "b1" }],
    ]);
    expect(r).toEqual({
      asOf: "2026-10-27T12:00:00.000Z",
      boundary: "ny-close",
      dayStart: "2026-10-26T21:00:00.000Z",
      weekStart: "2026-10-25T21:00:00.000Z",
      dayRealizedPnl: "12.34",
      weekRealizedPnl: "810.58",
      day: { closes: 2, grossPnl: "100.00", commission: "3.00", swap: "1.50", netPnl: "12.34" },
      week: { closes: 9, grossPnl: "100.00", commission: "3.00", swap: "1.50", netPnl: "810.58" },
    });
  });
});
