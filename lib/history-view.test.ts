import { describe, expect, it } from "vitest";
import { closesTotal, historyLines, type HistoryClose, type HistoryPositionLike } from "@/lib/history-view";

// WebTrader History = the terminal's one view (native HistoryDeals.SingleView, terminal 1.0.92).
const close = (at: string, volume: string, price: string, pnl: string, final = false, closedByTicket: number | null = null): HistoryClose =>
  ({ at, volume, price, pnl, closedByTicket, final });
const pos = (id: string, o: Partial<HistoryPositionLike>): HistoryPositionLike => ({
  id, status: "CLOSED", volume: "0", closePrice: null, realizedPnl: null, swap: "0", commission: "0", closedAt: null, ...o,
});

const openWithPartials = pos("open", {
  status: "OPEN", volume: "0.70", closedVolume: "0.30", swap: "-1", commission: "2",
  closes: [close("2026-10-20T10:00:00Z", "0.10", "100", "1"), close("2026-10-21T10:00:00Z", "0.20", "110", "4")],
});
const closedInParts = pos("parts", {
  closedAt: "2026-10-21T12:00:00Z", volume: "0.50", closedVolume: "1.00", closePrice: "120", realizedPnl: "10", closedPnl: "15", avgClosePrice: "115",
  swap: "-2", commission: "3",
  closes: [close("2026-10-19T12:00:00Z", "0.50", "110", "5"), close("2026-10-21T12:00:00Z", "0.50", "120", "10", true)],
});
const closedOnce = pos("once", {
  closedAt: "2026-10-20T08:00:00Z", volume: "1.00", closedVolume: "1.00", closePrice: "101", realizedPnl: "1", closedPnl: "1",
  closes: [close("2026-10-20T08:00:00Z", "1.00", "101", "1", true)],
});
const closedBy = pos("by", {
  closedAt: "2026-10-20T09:00:00Z", volume: "0.10", closedVolume: "0.10", closePrice: "99", realizedPnl: "-1", closedPnl: "-1",
  closes: [close("2026-10-20T09:00:00Z", "0.10", "99", "-1", true, 100000123)],
});
const voided = pos("void", { status: "VOIDED", closedAt: "2026-10-21T01:00:00Z", volume: "1", realizedPnl: "50", closes: [close("2026-10-21T01:00:00Z", "1", "150", "50", true)] });

describe("WebTrader History, one view", () => {
  it("open partials are flat rows; a closed position is one row, grouped when closed in parts or against another", () => {
    const lines = historyLines([openWithPartials, closedInParts, closedOnce, closedBy]);
    expect(lines.map((l) => [l.key, l.partial, l.group, l.lots, l.closePrice, l.pnl, l.children.length, l.swap, l.commission])).toEqual([
      ["parts", false, true, "1.00", "115", 15, 2, "-2", "3"],
      ["open:1", true, false, "0.20", "110", 4, 0, "0", "0"],
      ["open:0", true, false, "0.10", "100", 1, 0, "0", "0"],
      ["by", false, true, "0.10", "99", -1, 1, "0", "0"],
      ["once", false, false, "1.00", "101", 1, 0, "0", "0"],
    ]);
  });

  it("range: closed positions by their close time, open partials by their own", () => {
    const r = { from: "2026-10-21T00:00:00Z", to: "2026-10-21T23:59:59Z" };
    expect(historyLines([openWithPartials, closedInParts, closedOnce], r).map((l) => l.key)).toEqual(["parts", "open:1"]);
  });

  it("the total counts each close in the range at its own time, never a voided trade", () => {
    expect(closesTotal([openWithPartials, closedInParts, closedOnce, voided])).toEqual({ pnl: 21, closes: 5 });
    // the 19th partial of `parts` is outside: its position row still shows the whole 15, the total only the 10 inside
    expect(closesTotal([openWithPartials, closedInParts, voided], { from: "2026-10-21T00:00:00Z" })).toEqual({ pnl: 14, closes: 2 });
  });

  it("an older answer without closes is a plain row of the position", () => {
    const old = pos("old", { closedAt: "2026-10-01T00:00:00Z", volume: "0.3", closePrice: "5", realizedPnl: "2" });
    expect(historyLines([old]).map((l) => [l.group, l.lots, l.closePrice, l.pnl])).toEqual([[false, "0.3", "5", 2]]);
    expect(closesTotal([old])).toEqual({ pnl: 2, closes: 1 });
  });
});
