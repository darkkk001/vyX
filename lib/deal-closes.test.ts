import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { closesFromDeals, type CloseDeal } from "@/lib/deal-closes";
import { closesOf, type CloseTx } from "@/lib/history-closes";
import { dealReads } from "@/lib/deal-reads";

const D = (v: string | number) => new Prisma.Decimal(v);
const at = (s: number) => new Date(1_700_000_000_000 + s * 1000);
let seq = BigInt(1);
const deal = (s: number, volume: string, price: string, profit: number, o: Partial<CloseDeal> = {}): CloseDeal => ({
  positionId: "p1", entry: "OUT", ticket: (seq = seq + BigInt(1)), volume: D(volume), price: D(price), profit: D(profit), executedAt: at(s), byPositionId: null,
  transactionId: `t${seq}`, ...o,
});

describe("closesFromDeals", () => {
  it("matches closesOf for partial closes plus a final close (structured ledger rows)", () => {
    const txs: CloseTx[] = [
      { referenceId: "p1", amount: D(3), createdAt: at(10), note: null, closeVolume: D("0.3"), closePrice: D(100) },
      { referenceId: "p1", amount: D(2.2), createdAt: at(20), note: null, closeVolume: D("0.2"), closePrice: D(101) },
    ];
    const old = closesOf({ id: "p1", ticket: 1, status: "CLOSED", volume: D("0.2"), closePrice: D(101), closedAt: at(20) }, txs, [])!;
    const neu = closesFromDeals({ status: "CLOSED" }, [deal(10, "0.3", "100", 3), deal(20, "0.2", "101", 2.2)], new Map())!;
    expect(neu).toEqual(old);
  });

  it("names the close-by counterpart by ticket and groups even a single close-by", () => {
    const legs = closesFromDeals({ status: "CLOSED" }, [deal(5, "0.1", "2400", -1, { entry: "OUT_BY", byPositionId: "p9" })], new Map([["p9", 777]]))!;
    expect(legs).toEqual([{ at: at(5).toISOString(), volume: "0.1", price: "2400", pnl: "-1", closedByTicket: 777, final: true }]);
  });

  it("a plain single close stays flat in the default view and is listed in the closes=1 view", () => {
    const one = [deal(5, "1", "2400", 7)];
    expect(closesFromDeals({ status: "CLOSED" }, one, new Map())).toBeNull();
    expect(closesFromDeals({ status: "CLOSED" }, one, new Map(), { all: true })).toHaveLength(1);
  });

  it("an open position: nothing in the default view, partials (none final) in closes=1", () => {
    const d = [deal(5, "0.1", "2400", 1)];
    expect(closesFromDeals({ status: "OPEN" }, d, new Map())).toBeNull();
    expect(closesFromDeals({ status: "OPEN" }, d, new Map(), { all: true })![0].final).toBe(false);
  });

  it("a duplicate booking (0-lot OUT at the same instant) is listed, so the closes' P/L equals the ledger", () => {
    const legs = closesFromDeals({ status: "CLOSED" }, [deal(9, "0.01", "4604.011", -0.182), deal(9, "0", "4604.011", -0.182)], new Map())!;
    expect(legs.map((l) => l.volume)).toEqual(["0.01", "0"]);
    expect(legs.map((l) => l.final)).toEqual([false, true]);
    expect(legs.reduce((s, l) => s.add(l.pnl), D(0)).toString()).toBe("-0.364");
  });

  it("a reverse in place (OUT without a ledger row) is not a close", () => {
    const flip = deal(3, "0.01", "4465.31", 0, { transactionId: null });
    const legs = closesFromDeals({ status: "CLOSED" }, [flip, deal(9, "0.01", "4496.54", 31.23)], new Map(), { all: true })!;
    expect(legs).toHaveLength(1);
    expect([legs[0].price, legs[0].final]).toEqual(["4496.54", true]);
    expect(closesFromDeals({ status: "CLOSED" }, [flip, deal(9, "0.01", "4496.54", 31.23)], new Map())).toBeNull();
  });

  it("orders by execution time, then deal ticket", () => {
    const legs = closesFromDeals({ status: "CLOSED" }, [deal(20, "0.2", "2", 2), deal(10, "0.1", "1", 1)], new Map(), { all: true })!;
    expect(legs.map((l) => l.price)).toEqual(["1", "2"]);
  });
});

describe("dealReads", () => {
  it("reads the comma list; all turns everything on; unset is off", () => {
    expect(dealReads("history", undefined)).toBe(false);
    expect(dealReads("history", "")).toBe(false);
    expect(dealReads("history", "reports, History")).toBe(true);
    expect(dealReads("history", "all")).toBe(true);
    expect(dealReads("history", "historyx")).toBe(false);
  });
});
