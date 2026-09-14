import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// Neon side stubbed: these tests never open a database. Each stub records
// whether it was hit, which is how "fell back to Neon" is asserted.
const findUnique = vi.fn();
const findMany = vi.fn();
const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    livePrice: { findUnique: (...a: unknown[]) => findUnique(...a), findMany: (...a: unknown[]) => findMany(...a) },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));

import { getFreshPrices, getLivePriceRow, getLivePriceRowsWithSource } from "./live-price";

const nowIso = () => new Date().toISOString();
const engineRow = (symbol: string, bid: string, ask: string, tickAt = nowIso()) => ({ symbol, bid, ask, tickAt, updatedAt: nowIso(), ageMs: 120 });
const neonRow = (symbol: string, bid: string) => ({ symbol, bid: new Prisma.Decimal(bid), ask: new Prisma.Decimal(bid).add("0.2"), tickAt: new Date(), updatedAt: new Date() });

describe("lib/live-price with MARKET_DATA_PRICES=vps", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.MARKET_DATA_URL = "https://feed.example.test";
    process.env.MARKET_DATA_READ_SECRET = "read-secret";
    process.env.MARKET_DATA_PRICES = "vps";
    findUnique.mockReset(); findMany.mockReset(); queryRaw.mockReset();
  });
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("getLivePriceRow: engine tick -> Prisma LivePrice row, Neon untouched", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(engineRow("XAUUSD", "4500.85", "4501.05")), { status: 200 }));
    const row = (await getLivePriceRow("XAUUSD"))!;
    expect(row.symbol).toBe("XAUUSD");
    expect(row.bid).toBeInstanceOf(Prisma.Decimal);
    expect(row.ask.toString()).toBe("4501.05");
    expect(row.tickAt).toBeInstanceOf(Date);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("getLivePriceRow: engine 404 / error -> Neon's row", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    findUnique.mockResolvedValue(neonRow("XAUUSD", "4500.00"));
    const row = (await getLivePriceRow("XAUUSD"))!;
    expect(row.bid.toString()).toBe("4500");
    expect(findUnique).toHaveBeenCalledWith({ where: { symbol: "XAUUSD" } });
  });

  it("getLivePriceRowsWithSource: filters the engine's list to the wanted symbols and reports vps", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([engineRow("XAUUSD", "4500.85", "4501.05"), engineRow("EURUSD", "1.15", "1.15"), engineRow("BTCUSD", "78000", "78010")]), { status: 200 })
    );
    const { rows, source } = await getLivePriceRowsWithSource(["XAUUSD", "EURUSD"]);
    expect(source).toBe("vps");
    expect([...rows.keys()].sort()).toEqual(["EURUSD", "XAUUSD"]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("getLivePriceRowsWithSource: engine down -> Neon rows, source neon-fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    findMany.mockResolvedValue([neonRow("XAUUSD", "4500.00")]);
    const { rows, source } = await getLivePriceRowsWithSource(["XAUUSD"]);
    expect(source).toBe("neon-fallback");
    expect(rows.get("XAUUSD")!.bid.toString()).toBe("4500");
  });

  it("getFreshPrices: applies the 15 s tickAt gate to engine rows; stale symbols are absent", async () => {
    const stale = new Date(Date.now() - 60_000).toISOString();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([engineRow("XAUUSD", "4500.85", "4501.05"), engineRow("EURUSD", "1.15", "1.15", stale)]), { status: 200 })
    );
    const fresh = await getFreshPrices(["XAUUSD", "EURUSD"]);
    expect([...fresh.keys()]).toEqual(["XAUUSD"]);
    expect(fresh.get("XAUUSD")!.bid.toString()).toBe("4500.85");
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("flag off -> Neon only, the engine is never called", async () => {
    delete process.env.MARKET_DATA_PRICES;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    findUnique.mockResolvedValue(neonRow("XAUUSD", "4500.00"));
    queryRaw.mockResolvedValue([{ symbol: "XAUUSD", bid: new Prisma.Decimal("4500"), ask: new Prisma.Decimal("4500.2") }]);
    expect((await getLivePriceRow("XAUUSD"))!.bid.toString()).toBe("4500");
    expect((await getFreshPrices(["XAUUSD"])).size).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
