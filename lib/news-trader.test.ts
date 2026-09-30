import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { computeNewsTraderFlag, symbolNewsCurrencies, type NewsTrade, type NewsEvent } from "@/lib/risk-radar";
import { highImpactRows } from "@/lib/economic-events";

// web4 (issues.md 151, owner 2026-09-30): the news-trading rule's boundaries, pure (no DB).
const EVENT = new Date("2026-10-02T12:30:00Z"); // NFP-like
const events: NewsEvent[] = [{ eventAt: EVENT, currency: "USD" }];
const at = (offsetMs: number) => new Date(EVENT.getTime() + offsetMs);
const trade = (offsetMs: number, pnl: number | null = 10, extra: Partial<NewsTrade> = {}): NewsTrade => ({
  openedAt: at(offsetMs), currencies: ["USD"], closed: pnl !== null, realizedPnl: pnl === null ? null : new Prisma.Decimal(pnl), ...extra,
});
const far = (i: number): NewsTrade => trade(3_600_000 * (i + 1)); // hours away: never news
const ctx = { currency: "USD", windowFrom: new Date("2026-09-20T00:00:00Z"), collectingHistory: true };

describe("news-trading flag boundaries", () => {
  it("4 news trades never flag, 5 do (100% share, profitable)", () => {
    expect(computeNewsTraderFlag([0, 1, 2, 3].map(() => trade(0)), events, ctx).flag).toBe(false);
    const r = computeNewsTraderFlag([0, 1, 2, 3, 4].map(() => trade(0)), events, ctx);
    expect(r).toMatchObject({ flag: true, newsTrades: 5, totalTrades: 5, sharePct: 100, netPnl: "50.00", currency: "USD" });
  });
  it("share: 5 of 17 (29.4%) no, 5 of 16 (31.25%) yes, and exactly 30% (6 of 20) yes", () => {
    const news5 = [0, 1, 2, 3, 4].map(() => trade(0));
    expect(computeNewsTraderFlag([...news5, ...Array.from({ length: 12 }, (_, i) => far(i))], events, ctx).flag).toBe(false);
    expect(computeNewsTraderFlag([...news5, ...Array.from({ length: 11 }, (_, i) => far(i))], events, ctx).flag).toBe(true);
    const r = computeNewsTraderFlag([...[0, 1, 2, 3, 4, 5].map(() => trade(0)), ...Array.from({ length: 14 }, (_, i) => far(i))], events, ctx);
    expect({ flag: r.flag, share: r.sharePct }).toEqual({ flag: true, share: 30 });
    // 29.9% cannot be hit with whole trades at >= 5; 299 of 1000 is the closest: no
    const r2 = computeNewsTraderFlag([...Array.from({ length: 299 }, () => trade(0)), ...Array.from({ length: 701 }, (_, i) => far(i))], events, ctx);
    expect({ flag: r2.flag, share: r2.sharePct }).toEqual({ flag: false, share: 29.9 });
  });
  it("time: exactly +/-2:00 counts, 2:00.001 and 2:01 do not", () => {
    expect(computeNewsTraderFlag([-120_000, 120_000, -60_000, 0, 60_000].map((o) => trade(o)), events, ctx).newsTrades).toBe(5);
    expect(computeNewsTraderFlag([120_001, -120_001, 121_000, -121_000].map((o) => trade(o)), events, ctx).newsTrades).toBe(0);
  });
  it("net P/L exactly 0 does not flag; +0.01 does; a loss does not", () => {
    const zero = [10, -10, 5, -5, 0].map((p) => trade(0, p));
    expect(computeNewsTraderFlag(zero, events, ctx)).toMatchObject({ flag: false, netPnl: "0.00" });
    expect(computeNewsTraderFlag([10, -10, 5, -5, 0.01].map((p) => trade(0, p)), events, ctx)).toMatchObject({ flag: true, netPnl: "0.01" });
    expect(computeNewsTraderFlag([-1, -1, -1, -1, -1].map((p) => trade(0, p)), events, ctx).flag).toBe(false);
  });
  it("open news trades count toward 5 and 30% but not the P/L", () => {
    const r = computeNewsTraderFlag([trade(0, 3), trade(0, null), trade(0, null), trade(0, null), trade(0, null)], events, ctx);
    expect(r).toMatchObject({ flag: true, newsTrades: 5, openNewsTrades: 4, netPnl: "3.00" });
  });
  it("currency: a EUR event does not match a USD-only symbol; it matches EURUSD", () => {
    const eur: NewsEvent[] = [{ eventAt: EVENT, currency: "EUR" }];
    expect(computeNewsTraderFlag([0, 1, 2, 3, 4].map(() => trade(0)), eur, ctx).newsTrades).toBe(0);
    expect(computeNewsTraderFlag([0, 1, 2, 3, 4].map(() => trade(0, 1, { currencies: ["EUR", "USD"] })), eur, ctx).newsTrades).toBe(5);
  });
  it("trades before the window start are ignored (history not yet collected)", () => {
    const r = computeNewsTraderFlag([0, 1, 2, 3, 4].map(() => trade(0)), events, { ...ctx, windowFrom: at(3_600_000) });
    expect(r).toMatchObject({ flag: false, newsTrades: 0, totalTrades: 0, sharePct: null });
  });
  it("currency mapping from the stored symbol currencies", () => {
    expect(symbolNewsCurrencies({ baseCurrency: "EUR", quoteCurrency: "USD" })).toEqual(["EUR", "USD"]);
    expect(symbolNewsCurrencies({ baseCurrency: "XAU", quoteCurrency: "USD" })).toEqual(["USD"]);
    expect(symbolNewsCurrencies({ baseCurrency: "USD", quoteCurrency: "USD" })).toEqual(["USD"]);
    expect(symbolNewsCurrencies({ baseCurrency: "BTC", quoteCurrency: "USD" })).toEqual(["USD"]);
    expect(symbolNewsCurrencies({ baseCurrency: "TST", quoteCurrency: "ZZZ" })).toEqual([]);
  });
});

describe("event history keys", () => {
  it("high impact only, key has no time (re-timed in the day = same key), same-day duplicates numbered", () => {
    const rows = highImpactRows([
      { time: "2026-10-02T12:30:00Z", country: "USD", event: "Non-Farm Employment Change", impact: "High", actual: null, estimate: null, previous: null },
      { time: "2026-10-02T13:00:00Z", country: "USD", event: "Fed Chair Speaks", impact: "high", actual: null, estimate: null, previous: null },
      { time: "2026-10-02T18:00:00Z", country: "USD", event: "Fed Chair Speaks", impact: "high", actual: null, estimate: null, previous: null },
      { time: "2026-10-02T09:00:00Z", country: "EUR", event: "CPI Flash", impact: "medium", actual: null, estimate: null, previous: null },
      { time: "2026-10-02T09:00:00Z", country: "All", event: "G20 Meetings", impact: "high", actual: null, estimate: null, previous: null },
    ]);
    expect(rows.map((r) => r.sourceKey)).toEqual([
      "ff|USD|Non-Farm Employment Change|2026-10-02|1",
      "ff|USD|Fed Chair Speaks|2026-10-02|1",
      "ff|USD|Fed Chair Speaks|2026-10-02|2",
    ]);
    const moved = highImpactRows([{ time: "2026-10-02T14:30:00Z", country: "USD", event: "Non-Farm Employment Change", impact: "High", actual: null, estimate: null, previous: null }]);
    expect(moved[0].sourceKey).toBe(rows[0].sourceKey);
  });
});
