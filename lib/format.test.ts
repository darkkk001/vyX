import { describe, it, expect } from "vitest";
import {
  MINUS, formatNumber, formatMoney, formatSigned, formatPnl, formatVolume, formatPrice, formatPercent, formatMarginLevel,
  formatCsvNumber, tone, viewAmount, roundClean,
} from "@/lib/format";
import { toCsv } from "@/lib/csv";

// Step 2 "foundations" (owner number rules, docs/audit/2026-09-24/naming.md "Number rules" + "Empty and zero values").

describe("negative zero", () => {
  it("never shows -0.00: -0, -0.001 and -0.004 all show 0.00, unsigned and neutral", () => {
    for (const v of [-0, -0.001, -0.004, "-0.00", "-0"]) {
      expect(formatNumber(v)).toBe("0.00");
      expect(formatMoney(v)).toBe("0.00");
      expect(formatSigned(v)).toBe("0.00");
      expect(formatPnl(v).text).toBe("0.00");
      expect(formatPnl(v).tone).toBe("neutral");
      expect(tone(v)).toBe("neutral");
      expect(formatCsvNumber(v)).toBe("0.00");
      expect(formatVolume(v)).toBe("0.00");
    }
    expect(Object.is(roundClean(-0.001, 2), 0)).toBe(true);
    expect(formatPrice(-0.000001, 5)).toBe("0.00000");
  });
  it("a value that only rounds to zero at fewer decimals is still neutral at those decimals", () => {
    expect(formatSigned(-0.004, 2)).toBe("0.00");
    expect(formatSigned(-0.004, 3)).toBe(`${MINUS}0.004`);
  });
});

describe("signs", () => {
  it("positive +, negative U+2212 (never the ASCII hyphen), zero unsigned", () => {
    expect(formatSigned(1234.5)).toBe("+1,234.50");
    expect(formatSigned(-12)).toBe(`${MINUS}12.00`);
    expect(formatSigned(-12)).not.toContain("-");
    expect(formatSigned(0)).toBe("0.00");
    expect(formatNumber(-1500.256)).toBe(`${MINUS}1,500.26`);
    expect(formatNumber(1500.256)).toBe("1,500.26");
  });
  it("colour follows the shown value: profit / loss / neutral", () => {
    expect(formatPnl(5).tone).toBe("profit");
    expect(formatPnl(5).toneClass).toContain("--buy");
    expect(formatPnl(-5).tone).toBe("loss");
    expect(formatPnl(-5).toneClass).toContain("--sell");
    expect(formatPnl(0).toneClass).toBe("");
  });
  it("percent: signed deltas, unsigned rates, zero without a sign", () => {
    expect(formatPercent(12.4)).toBe("+12%");
    expect(formatPercent(-3.6, 1)).toBe(`${MINUS}3.6%`);
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(55, 0, false)).toBe("55%");
  });
});

describe("digits, volume, money", () => {
  it("prices in the symbol's own digits", () => {
    expect(formatPrice(4139.8, 2)).toBe("4,139.80");
    expect(formatPrice("1.08425", 5)).toBe("1.08425");
    expect(formatPrice(151.2, 3)).toBe("151.200");
    expect(formatPrice(2703, 2)).toBe("2,703.00");
  });
  it("volume always 2 decimals and never signed", () => {
    expect(formatVolume(1)).toBe("1.00");
    expect(formatVolume("0.5")).toBe("0.50");
    expect(formatVolume(0.02)).toBe("0.02");
    expect(formatVolume(-0.5)).toBe("0.50");
  });
  it("money 2 decimals with thousands separators; rounds half up like a person expects", () => {
    expect(formatMoney(50000)).toBe("50,000.00");
    expect(formatMoney(1.005)).toBe("1.01");
    expect(formatMoney({ toString: () => "-2500.5" })).toBe(`${MINUS}2,500.50`); // a Prisma Decimal
  });
});

describe("empty and zero values", () => {
  it("a value that does not exist is an empty string, never a dash", () => {
    for (const v of [null, undefined, "", "abc", NaN, Infinity]) {
      for (const s of [formatNumber(v), formatMoney(v), formatSigned(v), formatVolume(v), formatPrice(v, 2), formatPercent(v), formatCsvNumber(v), formatPnl(v).text]) {
        expect(s).toBe("");
      }
    }
  });
  it("zero money is 0.00", () => {
    expect(formatMoney(0)).toBe("0.00");
    expect(formatMoney("0")).toBe("0.00");
  });
  it("margin level without positions is empty, never 0%", () => {
    expect(formatMarginLevel(0, false)).toBe("");
    expect(formatMarginLevel(Infinity)).toBe("");
    expect(formatMarginLevel(null)).toBe("");
    expect(formatMarginLevel(254.4)).toBe("254%");
    expect(formatMarginLevel(1234.5, true, 2)).toBe("1,234.50%");
  });
});

describe("whose view", () => {
  it("commission (stored as the positive charge): broker +, client −", () => {
    expect(formatSigned(viewAmount("commission", 7, "broker"))).toBe("+7.00");
    expect(formatSigned(viewAmount("commission", 7, "client"))).toBe(`${MINUS}7.00`);
  });
  it("swap (stored client-signed): client as stored, broker the opposite", () => {
    expect(formatSigned(viewAmount("swap", -1.25, "client"))).toBe(`${MINUS}1.25`);
    expect(formatSigned(viewAmount("swap", -1.25, "broker"))).toBe("+1.25");
  });
  it("profit: client as stored, broker's side the opposite; withdrawals always −, deposits +", () => {
    expect(viewAmount("profit", 10, "client")).toBe(10);
    expect(viewAmount("profit", 10, "broker")).toBe(-10);
    expect(viewAmount("withdrawal", 100, "broker")).toBe(-100);
    expect(viewAmount("withdrawal", -100, "client")).toBe(-100);
    expect(viewAmount("deposit", -100, "broker")).toBe(100);
  });
  it("zero commission is 0.00 in both views (no -0)", () => {
    expect(formatSigned(viewAmount("commission", 0, "client"))).toBe("0.00");
    expect(Object.is(viewAmount("commission", 0, "client"), 0)).toBe(true);
    expect(viewAmount("swap", null, "client")).toBeNull();
  });
});

describe("CSV", () => {
  it("machine-readable: ASCII minus, no plus, no thousands separators, fixed decimals", () => {
    expect(formatCsvNumber(-1234.5)).toBe("-1234.50");
    expect(formatCsvNumber(1234.5)).toBe("1234.50");
    expect(formatCsvNumber(1.08425, 5)).toBe("1.08425");
  });
  it("toCsv keeps a negative number numeric but still neutralises formula text", () => {
    const csv = toCsv([{ a: formatCsvNumber(-12.5), b: "-1+1", c: "=HYPERLINK(1)", d: "+7" }], [
      { key: "a", label: "A" }, { key: "b", label: "B" }, { key: "c", label: "C" }, { key: "d", label: "D" },
    ]);
    expect(csv.split("\r\n")[1]).toBe("-12.50,'-1+1,'=HYPERLINK(1),'+7");
  });
});
