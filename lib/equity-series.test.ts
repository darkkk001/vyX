import { describe, expect, it } from "vitest";
import { buildEquitySeries, holdingAt } from "@/lib/equity-series";
import { snapshotsToWrite } from "@/lib/equity-snapshots";

const at = (s: string) => new Date(`2026-10-27T${s}Z`);

describe("holdingAt", () => {
  const iv = [{ openedAt: at("10:00:00"), closedAt: at("11:00:00") }, { openedAt: at("12:00:00"), closedAt: null }];
  it("is true inside an open interval and false outside it", () => {
    expect(holdingAt(iv, at("09:59:59"))).toBe(false);
    expect(holdingAt(iv, at("10:00:00"))).toBe(true);
    expect(holdingAt(iv, at("10:30:00"))).toBe(true);
    expect(holdingAt(iv, at("11:30:00"))).toBe(false);
    expect(holdingAt(iv, at("13:00:00"))).toBe(true);
  });
  it("the close's own P/L row, written just before closedAt, counts as after the close", () => {
    expect(holdingAt(iv, new Date(at("11:00:00").getTime() - 500))).toBe(false);
  });
});

describe("buildEquitySeries", () => {
  it("ledger points outside positions, snapshots inside, ordered, then now", () => {
    const s = buildEquitySeries({
      ledger: [
        { at: at("09:00:00"), equity: "1000.00" }, // deposit, flat
        { at: at("10:00:00"), equity: "997.00" }, // commission at the open: dropped (floating not in it)
        { at: at("10:59:59.500"), equity: "1040.00" }, // the close's P/L row: kept
      ],
      snapshots: [{ at: at("10:05:00"), equity: "1012.50" }, { at: at("10:10:00"), equity: "1031.25" }],
      intervals: [{ openedAt: at("10:00:00"), closedAt: at("11:00:00") }],
      now: { at: at("12:00:00"), equity: "1040.00" },
    });
    expect(s.map((p) => [p.t.slice(11, 19), p.equity, p.source])).toEqual([
      ["09:00:00", "1000.00", "ledger"],
      ["10:05:00", "1012.50", "snapshot"],
      ["10:10:00", "1031.25", "snapshot"],
      ["10:59:59", "1040.00", "ledger"],
      ["12:00:00", "1040.00", "now"],
    ]);
  });
});

describe("snapshotsToWrite", () => {
  const c = (accountId: string, equity: string, unpriced = 0) => ({ accountId, equity, balance: "0.00", credit: "0.00", floating: "0.00", unpriced });
  it("skips an account with an unpriced position and one whose equity did not change", () => {
    const r = snapshotsToWrite([c("a", "100.00"), c("b", "200.00"), c("c", "300.00", 1), c("d", "50.00")], new Map([["a", "100.00"], ["b", "199.99"]]));
    expect(r.write.map((x) => x.accountId)).toEqual(["b", "d"]);
    expect(r).toMatchObject({ unchanged: 1, skippedUnpriced: 1 });
  });
});
