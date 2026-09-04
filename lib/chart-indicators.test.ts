import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHART_INDICATORS,
  INDICATOR_DEFS,
  OVERLAY_INDICATOR_KEYS,
  SUBPANE_INDICATOR_KEYS,
  mergeChartIndicators,
  type IndicatorKey,
} from "./chart-indicators";

describe("INDICATOR_DEFS catalog", () => {
  it("has exactly the 13 indicators the terminal spec calls for", () => {
    expect(Object.keys(INDICATOR_DEFS).sort()).toEqual(
      ["ATR", "BOLL", "CCI", "EMA", "KDJ", "MA", "MACD", "OBV", "RSI", "SAR", "VOL", "VWAP", "WR"].sort()
    );
  });

  it("every overlay indicator is exactly the price-pane group the spec lists", () => {
    expect(OVERLAY_INDICATOR_KEYS.sort()).toEqual(["MA", "EMA", "BOLL", "SAR", "VWAP"].sort());
    for (const key of OVERLAY_INDICATOR_KEYS) {
      expect(INDICATOR_DEFS[key].pane).toBe("overlay");
    }
  });

  it("every sub-pane indicator is exactly the group the spec lists", () => {
    expect(SUBPANE_INDICATOR_KEYS.sort()).toEqual(["RSI", "MACD", "KDJ", "ATR", "VOL", "OBV", "CCI", "WR"].sort());
    for (const key of SUBPANE_INDICATOR_KEYS) {
      expect(INDICATOR_DEFS[key].pane).toBe("subpane");
    }
  });

  it("every def's defaultCalcParams length matches its own paramLabels length", () => {
    for (const def of Object.values(INDICATOR_DEFS)) {
      expect(def.defaultCalcParams.length).toBe(def.paramLabels.length);
    }
  });

  it("BOLL/SAR/MACD/KDJ/VOL/OBV/CCI keep klinecharts' own fixed-length built-in defaults exactly (their calc() indexes calcParams positionally)", () => {
    expect(INDICATOR_DEFS.BOLL.defaultCalcParams).toEqual([20, 2]);
    expect(INDICATOR_DEFS.SAR.defaultCalcParams).toEqual([2, 2, 20]);
    expect(INDICATOR_DEFS.MACD.defaultCalcParams).toEqual([12, 26, 9]);
    expect(INDICATOR_DEFS.KDJ.defaultCalcParams).toEqual([9, 3, 3]);
    expect(INDICATOR_DEFS.VOL.defaultCalcParams).toEqual([5, 10, 20]);
    expect(INDICATOR_DEFS.OBV.defaultCalcParams).toEqual([30]);
    expect(INDICATOR_DEFS.CCI.defaultCalcParams).toEqual([20]);
  });

  it("RSI defaults to a single period of 14, matching the spec's own example", () => {
    expect(INDICATOR_DEFS.RSI.defaultCalcParams).toEqual([14]);
  });

  it("VWAP and ATR are registered under a VYX_-prefixed klineName (custom klinecharts indicators, not built-ins)", () => {
    expect(INDICATOR_DEFS.VWAP.klineName).toBe("VYX_VWAP");
    expect(INDICATOR_DEFS.ATR.klineName).toBe("VYX_ATR");
  });

  it("every other indicator's klineName matches a real klinecharts built-in name (same as its own key)", () => {
    for (const def of Object.values(INDICATOR_DEFS)) {
      if (def.key === "VWAP" || def.key === "ATR") continue;
      expect(def.klineName).toBe(def.key);
    }
  });
});

describe("mergeChartIndicators", () => {
  it("returns the empty default for null/undefined/non-object input", () => {
    expect(mergeChartIndicators(null)).toEqual(DEFAULT_CHART_INDICATORS);
    expect(mergeChartIndicators(undefined)).toEqual(DEFAULT_CHART_INDICATORS);
    expect(mergeChartIndicators("garbage")).toEqual(DEFAULT_CHART_INDICATORS);
  });

  it("returns the empty default when `active` isn't an array", () => {
    expect(mergeChartIndicators({ active: "nope" })).toEqual(DEFAULT_CHART_INDICATORS);
    expect(mergeChartIndicators({})).toEqual(DEFAULT_CHART_INDICATORS);
  });

  it("passes through valid entries unchanged", () => {
    const saved = { active: [{ key: "RSI" as IndicatorKey, calcParams: [21] }] };
    expect(mergeChartIndicators(saved)).toEqual(saved);
  });

  it("drops entries with an unknown indicator key (forward-compat: a future version's saved blob referencing a key this version doesn't have)", () => {
    const saved = { active: [{ key: "RSI", calcParams: [14] }, { key: "SOME_FUTURE_INDICATOR", calcParams: [1] }] };
    expect(mergeChartIndicators(saved)).toEqual({ active: [{ key: "RSI", calcParams: [14] }] });
  });

  it("drops entries with a non-array, empty, or non-numeric calcParams", () => {
    const saved = {
      active: [
        { key: "MA", calcParams: "14" }, // not an array
        { key: "MA", calcParams: [] }, // empty
        { key: "MA", calcParams: [1, "x"] }, // non-numeric entry
        { key: "MA", calcParams: [9] }, // valid
      ],
    };
    expect(mergeChartIndicators(saved)).toEqual({ active: [{ key: "MA", calcParams: [9] }] });
  });

  it("keeps only the first occurrence of a duplicate key -- klinecharts allows at most one instance per indicator name per pane", () => {
    const saved = {
      active: [
        { key: "RSI", calcParams: [14] },
        { key: "RSI", calcParams: [21] },
      ],
    };
    expect(mergeChartIndicators(saved)).toEqual({ active: [{ key: "RSI", calcParams: [14] }] });
  });
});
