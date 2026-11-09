import { describe, expect, it } from "vitest";
import { parseSymbolPricingPatch } from "@/lib/pricing-editor-shared";

// Owner 2026-11-09: only the group per-symbol editor may store a negative markup (raw / zero-spread groups).
describe("parseSymbolPricingPatch: negative markup", () => {
  it("the group editor accepts a negative markup", () => {
    const r = parseSymbolPricingPatch({ spreadMarkup: "-1.3" }, { allowNegativeMarkup: true });
    expect(typeof r).toBe("object");
    expect(typeof r === "object" && r.spreadMarkup?.toString()).toBe("-1.3");
  });

  it("every other caller still refuses it, and a target or a commission is never negative", () => {
    expect(parseSymbolPricingPatch({ spreadMarkup: "-1.3" })).toBe("spreadMarkup must not be negative");
    expect(parseSymbolPricingPatch({ targetTotalSpreadPips: "-1" }, { allowNegativeMarkup: true })).toBe("targetTotalSpreadPips must not be negative");
    expect(parseSymbolPricingPatch({ commissionPerLot: "-1" }, { allowNegativeMarkup: true })).toBe("commissionPerLot must not be negative");
  });

  it("a markup >= 0 parses exactly as before with or without the option", () => {
    for (const v of ["0", "0.1", "1.5"]) {
      const a = parseSymbolPricingPatch({ spreadMarkup: v }); const b = parseSymbolPricingPatch({ spreadMarkup: v }, { allowNegativeMarkup: true });
      expect(typeof a === "object" && a.spreadMarkup?.toString()).toBe(v);
      expect(b).toEqual(a);
    }
  });
});
