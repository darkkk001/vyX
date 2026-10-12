import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { closeByTarget, closesOf, type CloseTx, type Counterpart, type HistoryPosition } from "@/lib/history-closes";

const D = (v: string | number) => new Prisma.Decimal(v);
const at = (s: number) => new Date(1_700_000_000_000 + s * 1000);
const pos = (o: Partial<HistoryPosition> = {}): HistoryPosition => ({ id: "p1", ticket: 100, status: "CLOSED", volume: D("0.5"), closePrice: D("102"), closedAt: at(30), ...o });
const tx = (s: number, amount: number, note: string | null): CloseTx => ({ referenceId: "p1", amount: D(amount), createdAt: at(s), note });

describe("closesOf", () => {
  it("reads partial closes from their notes and the final close from the row", () => {
    const legs = closesOf(pos(), [tx(10, 3, "Partial close: 0.3 lots @ 100"), tx(20, 2.2, "Partial close: 0.20 lots @ 101"), tx(30, 6, null)], [])!;
    expect(legs.map((l) => [l.volume, l.price, l.pnl, l.final])).toEqual([["0.3", "100", "3", false], ["0.20", "101", "2.2", false], ["0.5", "102", "6", true]]);
  });
  it("sorts by time whatever order the transactions arrive in", () => {
    const legs = closesOf(pos(), [tx(30, 6, null), tx(10, 3, "Partial close: 0.5 lots @ 100")], [])!;
    expect(legs.map((l) => l.final)).toEqual([false, true]);
  });
  it("a lone plain close is not grouped", () => expect(closesOf(pos(), [tx(30, 6, null)], [])).toBeNull());
  it("an open position, or one with no transactions, is never grouped", () => {
    expect(closesOf(pos({ status: "OPEN" }), [tx(10, 1, "Partial close: 0.1 lots @ 100"), tx(20, 1, null)], [])).toBeNull();
    expect(closesOf(pos(), [], [])).toBeNull();
  });
  it("a lone close-by names the other side by id or by ticket, and is grouped", () => {
    const other: Counterpart = { id: "p2", ticket: 200, status: "CLOSED", volume: D("0.5"), closePrice: D("102"), closedAt: at(30) };
    expect(closesOf(pos(), [tx(30, 6, "Close by p2")], [other])![0]).toMatchObject({ final: true, closedByTicket: 200 });
    expect(closesOf(pos(), [tx(30, 6, "Close by #200")], [other])![0].closedByTicket).toBe(200);
    expect(closesOf(pos(), [tx(30, 6, "Close by #999")], [])![0].closedByTicket).toBe(999);   // the ticket in the note itself
  });
  it("a partial close-by leg takes volume and price from the counterpart's closing row, only when it closed at the same moment", () => {
    const other: Counterpart = { id: "p2", ticket: 200, status: "CLOSED", volume: D("0.4"), closePrice: D("100.05"), closedAt: at(10) };
    const legs = closesOf(pos(), [tx(10, 4, "Close by p2"), tx(30, 6, null)], [other])!;
    expect(legs[0]).toMatchObject({ volume: "0.4", price: "100.05", final: false, closedByTicket: 200 });
    // the counterpart closed long after this leg: not the same close-by, so nothing is guessed
    expect(closesOf(pos(), [tx(10, 4, "Close by p2"), tx(30, 6, null)], [{ ...other, closedAt: at(90) }])).toBeNull();
    expect(closesOf(pos(), [tx(10, 4, "Close by p2"), tx(30, 6, null)], [])).toBeNull();
  });
});

describe("closeByTarget", () => {
  it("reads ids and tickets, nothing else", () => {
    expect(closeByTarget("Close by abc123")).toEqual({ id: "abc123" });
    expect(closeByTarget("Close by #77")).toEqual({ ticket: 77 });
    expect(closeByTarget("Partial close: 1 lots @ 2")).toBeNull();
    expect(closeByTarget(null)).toBeNull();
  });
});
