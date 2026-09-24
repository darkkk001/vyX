import { describe, expect, it } from "vitest";
import { MAX_LEVERAGE, parseLeverage } from "@/lib/leverage";
import { requiredMarginFor } from "@/lib/margin";
import { Prisma } from "@prisma/client";

describe("parseLeverage", () => {
  it("accepts plain, 1:N and grouped forms", () => {
    expect(parseLeverage(1000000)).toBe(1000000);
    expect(parseLeverage("1000000")).toBe(1000000);
    expect(parseLeverage("1,000,000")).toBe(1000000);
    expect(parseLeverage("10,00,000")).toBe(1000000);
    expect(parseLeverage("1:500")).toBe(500);
    expect(parseLeverage(" 1 000 000 ")).toBe(1000000);
    expect(parseLeverage(MAX_LEVERAGE)).toBe(MAX_LEVERAGE);
  });

  it("refuses what is not a whole number from 1 to the ceiling", () => {
    for (const bad of [0, -5, 1.5, "1.5", "abc", "", "1,00", "1,,000", MAX_LEVERAGE + 1, "3000000000", NaN, null, undefined, {}]) {
      expect(parseLeverage(bad), String(bad)).toBeNull();
    }
  });

  it("very high leverage keeps margin exact and above zero (the stop-out still has a level to measure)", () => {
    const m = requiredMarginFor(new Prisma.Decimal("0.01"), new Prisma.Decimal(100), new Prisma.Decimal("4270.55"), 10_000_000);
    expect(m.toString()).toBe("0.000427055");
    expect(m.gt(0)).toBe(true);
  });
});
