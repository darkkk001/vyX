import { describe, expect, it } from "vitest";
import { planFix } from "./fix-usdx";

const dec = (s: string) => ({ toString: () => s });
function fake(bs: Record<string, unknown> | null, peer: Record<string, unknown> = { id: "p", minLot: dec("0.01"), maxLot: dec("100"), lotStep: dec("0.01"), hedgedMarginPct: dec("50"), tradingMode: "BOTH", defaultBookType: "B_BOOK", symbol: { name: "US30" } }) {
  const writes: string[] = [];
  return {
    writes,
    broker: { findUnique: async () => ({ id: "b1", name: "Futurix Global", subdomain: "futurixglobal" }) },
    symbol: { findUnique: async () => ({ id: "s1", name: "USDX", category: "INDICES", baseCurrency: "USD", quoteCurrency: "USD", digits: 3, contractSize: dec("100") }) },
    brokerSymbol: { findUnique: async () => bs, findMany: async () => [peer], update: async () => { writes.push("update"); } },
    tradingSession: { count: async () => 0 },
    groupSymbolConfig: { count: async () => 0 },
    auditLog: { create: async () => { writes.push("audit"); } },
  };
}
const complete = { id: "bs1", enabled: true, minLot: dec("0.01"), maxLot: dec("100"), lotStep: dec("0.01"), hedgedMarginPct: dec("50"), tradingMode: "BOTH", defaultBookType: "B_BOOK" };

describe("fix-usdx", () => {
  it("USDX as it is in production is complete: nothing planned, nothing written", async () => {
    const db = fake(complete);
    const r = await planFix(db as never, { broker: "futurixglobal", name: "USDX", apply: true });
    expect(r.changes).toBe(0); expect(db.writes).toEqual([]);
    expect(r.lines.join("\n")).toMatch(/COMPLETE: nothing is missing/);
  });

  it("an incomplete row is filled from the template, only the missing fields, audited; dry run writes nothing", async () => {
    const broken = { ...complete, minLot: dec("0"), lotStep: dec("0") };
    const dry = fake(broken);
    const d = await planFix(dry as never, { broker: "futurixglobal", name: "USDX", apply: false });
    expect(d.changes).toBe(2); expect(dry.writes).toEqual([]);
    expect(d.lines.join("\n")).toMatch(/PLAN +set minimum lot = 0.01 \(from US30\)/);
    const live = fake(broken);
    await planFix(live as never, { broker: "futurixglobal", name: "USDX", apply: true });
    expect(live.writes).toEqual(["update", "audit"]);
  });

  it("a missing broker row is not 'fixed' here", async () => {
    const r = await planFix(fake(null) as never, { broker: "futurixglobal", name: "USDX", apply: true });
    expect(r.changes).toBe(0); expect(r.lines.join("\n")).toMatch(/NO broker row/);
  });
});
