import { describe, expect, it } from "vitest";
import { addFeedSymbol } from "./add-feed-symbol";

// A tiny in-memory stand-in for the Prisma transaction the script uses (the script's own guards and writes are what is under test).
function fakeDb(opts: { templateLots?: { minLot: string; maxLot: string; lotStep: string }; sessions?: number; groupRows?: boolean } = {}) {
  const writes: string[] = [];
  const lots = opts.templateLots ?? { minLot: "0.01", maxLot: "100", lotStep: "0.01" };
  const dec = (s: string) => ({ toString: () => s });
  const db = {
    writes,
    broker: { findUnique: async () => ({ id: "b1", name: "Futurix Global", subdomain: "futurixglobal" }) },
    $queryRaw: async () => [],
    symbol: {
      findUnique: async () => null,
      create: async () => { writes.push("symbol.create"); return { id: "newsym" }; },
    },
    brokerSymbol: {
      findUnique: async () => null,
      findMany: async () => [{ id: "bs-us30", symbolId: "us30", minLot: dec(lots.minLot), maxLot: dec(lots.maxLot), lotStep: dec(lots.lotStep), hedgedMarginPct: dec("50"), defaultBookType: "B_BOOK", tradingMode: "BOTH", symbol: { name: "US30", category: "INDICES" } }],
      create: async () => { writes.push("brokerSymbol.create"); return { id: "newbs" }; },
    },
    tradingSession: {
      findMany: async () => Array.from({ length: opts.sessions ?? 0 }, (_, i) => ({ dayOfWeek: i, openTime: "00:00", closeTime: "23:59" })),
      createMany: async (a: { data: unknown[] }) => { writes.push(`tradingSession.createMany ${a.data.length}`); },
    },
    group: { findMany: async (a: { select: { name?: boolean } }) => (a.select.name && !("id" in a.select) ? [] : [{ id: "g1", name: "Standard" }, { id: "g2", name: "Pro" }]) },
    groupSymbolConfig: {
      findMany: async () => (opts.groupRows ? [{ groupId: "g1", spreadMarkup: null, targetTotalSpreadPips: null, commissionPerLot: null, swapLong: null, swapShort: null }, { groupId: "g2", spreadMarkup: null, targetTotalSpreadPips: null, commissionPerLot: null, swapLong: null, swapShort: null }] : []),
      createMany: async (a: { data: unknown[] }) => { writes.push(`groupSymbolConfig.createMany ${a.data.length}`); },
    },
    auditLog: { create: async () => { writes.push("auditLog.create"); } },
  };
  return db;
}
const args = { broker: "futurixglobal", name: "USDX", category: "INDICES" as const, base: "USD", quote: "USD", digits: 3, contractSize: 100 };

describe("add-feed-symbol", () => {
  it("dry run writes nothing", async () => {
    const db = fakeDb();
    const r = await addFeedSymbol(db as never, { ...args, apply: false });
    expect(db.writes).toEqual([]);
    expect(r.changes).toBe(2);
    expect(r.lines.join("\n")).toMatch(/DRY RUN/);
  });

  it("a complete symbol is created in full: global symbol, broker row, audit; hours / group rows copied from the template when it has them", async () => {
    const db = fakeDb({ sessions: 5, groupRows: true });
    await addFeedSymbol(db as never, { ...args, apply: true });
    expect(db.writes).toEqual(["symbol.create", "brokerSymbol.create", "tradingSession.createMany 5", "groupSymbolConfig.createMany 2", "auditLog.create"]);
  });

  it("takes the lots from the template, not from a guess", async () => {
    const db = fakeDb({ templateLots: { minLot: "0.10", maxLot: "50", lotStep: "0.10" } });
    const r = await addFeedSymbol(db as never, { ...args, apply: false });
    expect(r.lines.join("\n")).toMatch(/lots 0\.10 to 50 step 0\.10/);
  });

  it("REFUSES a symbol that would be incomplete, lists what is missing, and writes nothing", async () => {
    const db = fakeDb({ templateLots: { minLot: "0", maxLot: "100", lotStep: "0.01" } });   // the template itself has no minimum lot
    await expect(addFeedSymbol(db as never, { ...args, apply: true })).rejects.toThrow(/USDX would be incomplete: Minimum lot is not set/);
    expect(db.writes).toEqual([]);
  });

  it("refuses a missing contract size / digits before touching anything", async () => {
    const db = fakeDb();
    await expect(addFeedSymbol(db as never, { ...args, contractSize: 0, apply: true })).rejects.toThrow(/contract-size/);
    await expect(addFeedSymbol(db as never, { ...args, digits: 12, apply: true })).rejects.toThrow(/digits/);
    expect(db.writes).toEqual([]);
  });
});
