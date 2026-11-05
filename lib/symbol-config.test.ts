import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { EXTRA_KEYS, changedAgainst, crossCheck, parseSymbolFields } from "@/lib/symbol-config";
import { parseCsv } from "@/lib/symbol-csv";

const parse = (input: Record<string, unknown>) => parseSymbolFields(input, EXTRA_KEYS);

describe("parseSymbolFields: the new fields", () => {
  it("a field that is not sent is left alone (no key in data)", () => {
    expect(parse({})).toEqual({ data: {}, errors: [] });
  });

  it("null and empty clear an optional field", () => {
    for (const k of EXTRA_KEYS) {
      expect(parse({ [k]: null }).data[k], k).toBeNull();
      expect(parse({ [k]: "" }).data[k], k).toBeNull();
    }
  });

  it("valid values are accepted and normalised", () => {
    const { data, errors } = parse({
      tickSize: "0.00001",
      tickValue: 1,
      marginCurrency: "usd",
      profitCurrency: " eur ",
      executionMode: "INSTANT",
      fillPolicy: "IOC",
      swapType: "PERCENT",
      tripleSwapDay: "3",
      freezeLevel: 5,
      marginInitial: "0.01",
      marginMaintenance: "0.005",
      description: " Spot gold ",
      displayOrder: 2,
    });
    expect(errors).toEqual([]);
    expect(String(data.tickSize)).toBe("0.00001");
    expect(data.marginCurrency).toBe("USD");
    expect(data.profitCurrency).toBe("EUR");
    expect(data.tripleSwapDay).toBe(3);
    expect(data.description).toBe("Spot gold");
    expect(data.displayOrder).toBe(2);
    expect(data.tickValue).toBeInstanceOf(Prisma.Decimal);
  });

  it.each([
    ["tickSize", "abc"],
    ["tickSize", "-1"],
    ["tickSize", "0.00000000001"],
    ["tickValue", "1e30"],
    ["marginCurrency", "US"],
    ["marginCurrency", "USDX"],
    ["profitCurrency", "12$"],
    ["executionMode", "LIMIT"],
    ["fillPolicy", "RETURN"],
    ["swapType", "POINT"],
    ["tripleSwapDay", 7],
    ["tripleSwapDay", -1],
    ["tripleSwapDay", "1.5"],
    ["freezeLevel", -1],
    ["freezeLevel", "x"],
    ["marginInitial", -0.1],
    ["marginMaintenance", "NaN"],
    ["description", "x".repeat(501)],
    ["displayOrder", -1],
    ["displayOrder", 1.5],
  ])("refuses %s = %j", (field, value) => {
    const r = parse({ [field]: value });
    expect(r.errors.map((e) => e.field)).toEqual([field]);
    expect(r.data[field]).toBeUndefined();
  });
});

describe("parseSymbolFields: the core settings keep the existing rules", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("tradingMode accepts CLOSE_ONLY (with SYMBOL_CLOSE_ONLY_ENABLED=1) and refuses unknown", () => {
    vi.stubEnv("SYMBOL_CLOSE_ONLY_ENABLED", "1");
    expect(parseSymbolFields({ tradingMode: "CLOSE_ONLY" }).data.tradingMode).toBe("CLOSE_ONLY");
    expect(parseSymbolFields({ tradingMode: "HALF" }).errors).toHaveLength(1);
  });
  it("2026-11-05: CLOSE_ONLY is refused until the engine knows it (flag unset or not exactly 1); the other modes are unaffected", () => {
    for (const v of [undefined, "0", "true"]) {
      vi.stubEnv("SYMBOL_CLOSE_ONLY_ENABLED", v as string);
      const r = parseSymbolFields({ tradingMode: "CLOSE_ONLY" });
      expect([r.data.tradingMode, r.errors]).toEqual([undefined, [{ field: "tradingMode", reason: "Close only arrives with the next server update" }]]);
    }
    expect(parseSymbolFields({ tradingMode: "BUY_ONLY" }).data.tradingMode).toBe("BUY_ONLY");
  });
  it("blank markup / swap means zero, lots must be above zero, maxExposure blank means no limit", () => {
    const r = parseSymbolFields({ spreadMarkup: "", swapLong: null, maxLot: "0", maxExposure: "" });
    expect(String(r.data.spreadMarkup)).toBe("0");
    expect(String(r.data.swapLong)).toBe("0");
    expect(r.data.maxExposure).toBeNull();
    expect(r.errors.map((e) => e.field)).toEqual(["maxLot"]);
  });
  it("crossCheck: minLot above maxLot is refused on the values after the write", () => {
    const cur = { minLot: new Prisma.Decimal(1), maxLot: new Prisma.Decimal(10) };
    expect(crossCheck(cur, { maxLot: new Prisma.Decimal("0.5") })).toHaveLength(1);
    expect(crossCheck(cur, { maxLot: new Prisma.Decimal(5) })).toHaveLength(0);
    expect(crossCheck(null, { minLot: new Prisma.Decimal(200) })).toHaveLength(1);
  });
  it("changedAgainst: only the keys that differ from the stored row; every key when there is no row", () => {
    const view = { swapLong: "0", maxLot: "100", tickSize: null } as never;
    expect(changedAgainst(view, { swapLong: new Prisma.Decimal(0), maxLot: new Prisma.Decimal(5), tickSize: null })).toEqual(["maxLot"]);
    expect(changedAgainst(null, { swapLong: 0 })).toEqual(["swapLong"]);
  });
});

describe("parseCsv", () => {
  it("reads quoted cells, doubled quotes, CRLF, a BOM and reports the start line of each record", () => {
    const rows = parseCsv('﻿symbolName,description\r\nEURUSD,"Euro, Dollar"\r\n\r\nXAUUSD,"Gold ""spot""\nline two"\r\nGBPUSD,\r\n');
    expect(rows.map((r) => r.line)).toEqual([1, 2, 4, 6]);
    expect(rows[1].cells).toEqual(["EURUSD", "Euro, Dollar"]);
    expect(rows[2].cells).toEqual(["XAUUSD", 'Gold "spot"\nline two']);
    expect(rows[3].cells).toEqual(["GBPUSD", ""]);
  });
  it("an empty file has no records", () => {
    expect(parseCsv("")).toEqual([]);
  });
});
