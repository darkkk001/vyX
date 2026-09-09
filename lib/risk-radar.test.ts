import { describe, it, expect } from "vitest";
import { computeRiskRadarRow, computeMartingaleFlag, computeLatencyArbFlag, type RiskRadarPosition } from "@/lib/risk-radar";

const mkPos = (overrides: Partial<RiskRadarPosition>): RiskRadarPosition => ({
  accountId: "acc1",
  volume: 0.1,
  realizedPnl: 10,
  openedAt: new Date("2026-09-01T10:00:00Z"),
  closedAt: new Date("2026-09-01T10:05:00Z"),
  ...overrides,
});

describe("computeRiskRadarRow", () => {
  it("returns a zeroed row with no flags for an account with no trades", () => {
    const row = computeRiskRadarRow("acc1", "1001", []);
    expect(row.trades30d).toBe(0);
    expect(row.winRatePct).toBeNull();
    expect(row.scalpFlag).toBe(false);
    expect(row.martingaleFlag).toBe(false);
    expect(row.newsTraderFlag).toBe(false);
  });

  it("computes win rate, avg hold, avg lot, and profit velocity correctly", () => {
    const positions = [
      mkPos({ realizedPnl: 100, volume: 0.1, openedAt: new Date("2026-09-01T10:00:00Z"), closedAt: new Date("2026-09-01T10:10:00Z") }),
      mkPos({ realizedPnl: -50, volume: 0.2, openedAt: new Date("2026-09-01T11:00:00Z"), closedAt: new Date("2026-09-01T11:20:00Z") }),
    ];
    const row = computeRiskRadarRow("acc1", "1001", positions);
    expect(row.trades30d).toBe(2);
    expect(row.winRatePct).toBe(50);
    expect(row.avgHoldMinutes).toBe(15); // (10 + 20) / 2
    expect(row.avgLot).toBeCloseTo(0.15);
    expect(row.profitVelocityPerDay).toBeCloseTo((100 - 50) / 30);
  });

  it("flags scalping when average hold time is under 2 minutes", () => {
    const positions = [
      mkPos({ openedAt: new Date("2026-09-01T10:00:00Z"), closedAt: new Date("2026-09-01T10:01:00Z") }),
      mkPos({ openedAt: new Date("2026-09-01T11:00:00Z"), closedAt: new Date("2026-09-01T11:01:30Z") }),
    ];
    expect(computeRiskRadarRow("acc1", "1001", positions).scalpFlag).toBe(true);
  });

  it("does not flag scalping for normal hold times", () => {
    const positions = [mkPos({ openedAt: new Date("2026-09-01T10:00:00Z"), closedAt: new Date("2026-09-01T10:30:00Z") })];
    expect(computeRiskRadarRow("acc1", "1001", positions).scalpFlag).toBe(false);
  });
});

describe("computeMartingaleFlag", () => {
  it("flags repeated size-up-after-loss patterns", () => {
    const positions: RiskRadarPosition[] = [
      mkPos({ volume: 0.1, realizedPnl: -10, closedAt: new Date("2026-09-01T10:00:00Z") }),
      mkPos({ volume: 0.2, realizedPnl: -10, closedAt: new Date("2026-09-01T11:00:00Z") }), // 2x after loss
      mkPos({ volume: 0.4, realizedPnl: -10, closedAt: new Date("2026-09-01T12:00:00Z") }), // 2x after loss
      mkPos({ volume: 0.8, realizedPnl: 50, closedAt: new Date("2026-09-01T13:00:00Z") }), // 2x after loss
    ];
    expect(computeMartingaleFlag(positions)).toBe(true);
  });

  it("does not flag consistent, non-escalating lot sizes", () => {
    const positions: RiskRadarPosition[] = [
      mkPos({ volume: 0.1, realizedPnl: -10, closedAt: new Date("2026-09-01T10:00:00Z") }),
      mkPos({ volume: 0.1, realizedPnl: -10, closedAt: new Date("2026-09-01T11:00:00Z") }),
      mkPos({ volume: 0.1, realizedPnl: 20, closedAt: new Date("2026-09-01T12:00:00Z") }),
    ];
    expect(computeMartingaleFlag(positions)).toBe(false);
  });

  it("does not flag a single size-up occurrence (below the minimum hit count)", () => {
    const positions: RiskRadarPosition[] = [
      mkPos({ volume: 0.1, realizedPnl: -10, closedAt: new Date("2026-09-01T10:00:00Z") }),
      mkPos({ volume: 0.3, realizedPnl: 20, closedAt: new Date("2026-09-01T11:00:00Z") }),
    ];
    expect(computeMartingaleFlag(positions)).toBe(false);
  });

  it("does not flag size-ups that follow a winning trade", () => {
    const positions: RiskRadarPosition[] = [
      mkPos({ volume: 0.1, realizedPnl: 10, closedAt: new Date("2026-09-01T10:00:00Z") }),
      mkPos({ volume: 0.3, realizedPnl: 10, closedAt: new Date("2026-09-01T11:00:00Z") }),
      mkPos({ volume: 0.9, realizedPnl: 10, closedAt: new Date("2026-09-01T12:00:00Z") }),
    ];
    expect(computeMartingaleFlag(positions)).toBe(false);
  });
});

describe("computeLatencyArbFlag", () => {
  const fastWin = (i: number) =>
    mkPos({
      realizedPnl: 5,
      openedAt: new Date(2026, 8, 1, 10, 0, i * 2),
      closedAt: new Date(2026, 8, 1, 10, 0, i * 2 + 1), // 1s hold
    });
  const normalTrade = (i: number, pnl: number) =>
    mkPos({
      realizedPnl: pnl,
      openedAt: new Date(2026, 8, 1, 12, i, 0),
      closedAt: new Date(2026, 8, 1, 12, i + 20, 0), // 20min hold
    });

  it("flags a burst of sub-3s trades winning far more than the account's own normal rate", () => {
    // 10 fast trades, all wins; 10 normal trades, 50% win rate --
    // overall win rate 75%, fast-trade win rate 100% (>= 75+25 is false,
    // so widen the gap: make normal trades mostly losers instead).
    const fast = Array.from({ length: 10 }, (_, i) => fastWin(i));
    const normal = Array.from({ length: 10 }, (_, i) => normalTrade(i, i < 2 ? 5 : -5)); // 20% win rate
    const positions = [...fast, ...normal];
    // overall win rate = 12/20 = 60%; fast win rate = 100% -- delta 40 >= 25
    expect(computeLatencyArbFlag(positions)).toBe(true);
  });

  it("does not flag when there are too few fast trades", () => {
    const fast = Array.from({ length: 3 }, (_, i) => fastWin(i)); // below MIN_FAST_TRADES
    const normal = Array.from({ length: 10 }, (_, i) => normalTrade(i, -5));
    expect(computeLatencyArbFlag([...fast, ...normal])).toBe(false);
  });

  it("does not flag fast trades whose win rate is in line with the account's overall rate", () => {
    const fast = Array.from({ length: 10 }, (_, i) => fastWin(i)); // 100% win
    const normal = Array.from({ length: 10 }, (_, i) => normalTrade(i, 5)); // 100% win too
    // overall win rate 100%, fast win rate 100% -- no delta at all
    expect(computeLatencyArbFlag([...fast, ...normal])).toBe(false);
  });
});
