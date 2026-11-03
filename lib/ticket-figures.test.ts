import { describe, expect, it } from "vitest";
import { pointValue, riskReward } from "./ticket-figures";

describe("pointValue", () => {
  it("is one point at the ticket volume in the account currency", () => {
    // XAUUSD, contract 100, 0.01 lot, USD account: one price unit = 1.00, one point (0.01) = 0.01
    expect(pointValue(100 * 0.01 * 1, 2)).toBeCloseTo(0.01, 10);
    // EURUSD, contract 100000, 1 lot: one point (0.00001) = 1.00
    expect(pointValue(100000, 5)).toBeCloseTo(1, 10);
  });

  it("is unknown while the conversion is unpriced", () => {
    expect(pointValue(null, 2)).toBeNull();
  });
});

describe("riskReward", () => {
  it("measures risk to the stop and reward to the target", () => {
    const r = riskReward(4450, 4440, 4470, 1);
    expect(r).toEqual({ risk: 10, reward: 20, ratio: 2 });
  });

  it("is zero for a level not set, and the ratio needs both", () => {
    expect(riskReward(4450, NaN, 4470, 1)).toEqual({ risk: 0, reward: 20, ratio: 0 });
    expect(riskReward(4450, NaN, NaN, 1)).toEqual({ risk: 0, reward: 0, ratio: 0 });
    expect(riskReward(4450, 4440, 4470, null)).toEqual({ risk: 0, reward: 0, ratio: 0 });
  });
});
