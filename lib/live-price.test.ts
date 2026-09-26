import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// Neon side stubbed: these tests never open a database. Each stub records
// whether it was hit, which is how "fell back to Neon" is asserted.
const findUnique = vi.fn();
const findMany = vi.fn();
const queryRaw = vi.fn();
// the no-price alert (lib/price-source-alert.ts) writes staff notifications: recorded here
const notificationFindFirst = vi.fn();
const notificationCreateMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    livePrice: { findUnique: (...a: unknown[]) => findUnique(...a), findMany: (...a: unknown[]) => findMany(...a) },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
    notification: { findFirst: (...a: unknown[]) => notificationFindFirst(...a), createMany: (...a: unknown[]) => notificationCreateMany(...a) },
    broker: { findMany: async () => [{ id: "b1" }, { id: "b2" }] },
  },
}));

import { getFreshPrices, getLivePriceRow, getLivePriceRowsWithSource } from "./live-price";
import { resetPriceSourceAlertThrottle } from "./price-source-alert";

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
    notificationFindFirst.mockReset(); notificationCreateMany.mockReset();
    notificationFindFirst.mockResolvedValue(null);
    resetPriceSourceAlertThrottle();
    vi.spyOn(console, "error").mockImplementation(() => {});
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

  // Owner decision 2026-09-26: never Neon's frozen LivePrice when the engine read fails -- no price, and an alert.
  it("getLivePriceRow: engine 404 -> no price, no alert, Neon untouched", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    findUnique.mockResolvedValue(neonRow("XAUUSD", "4500.00"));
    expect(await getLivePriceRow("XAUUSD")).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(notificationCreateMany).not.toHaveBeenCalled();
  });

  it("getLivePriceRow: engine unreachable / 5xx -> no price, Neon untouched, one staff alert per broker", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 502 }));
    findUnique.mockResolvedValue(neonRow("XAUUSD", "4500.00"));
    expect(await getLivePriceRow("XAUUSD")).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(notificationCreateMany).toHaveBeenCalledTimes(1);
    const rows = notificationCreateMany.mock.calls[0][0].data as { brokerId: string; type: string; title: string }[];
    expect(rows.map((r) => [r.brokerId, r.type, r.title])).toEqual([["b1", "PRICE_SOURCE_DOWN", "Live prices unavailable"], ["b2", "PRICE_SOURCE_DOWN", "Live prices unavailable"]]);
    // a second failure right after: throttled, no second alert
    await getLivePriceRow("XAUUSD");
    expect(notificationCreateMany).toHaveBeenCalledTimes(1);
  });

  it("the alert is not repeated while one from the last 5 minutes exists (any serverless instance)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    notificationFindFirst.mockResolvedValue({ id: "recent" });
    expect(await getLivePriceRow("XAUUSD")).toBeNull();
    expect(notificationCreateMany).not.toHaveBeenCalled();
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

  it("getLivePriceRowsWithSource: engine down -> NO rows (source vps-unavailable), Neon untouched, alerted", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    findMany.mockResolvedValue([neonRow("XAUUSD", "4500.00")]);
    const { rows, source } = await getLivePriceRowsWithSource(["XAUUSD"]);
    expect(source).toBe("vps-unavailable");
    expect(rows.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
    expect(notificationCreateMany).toHaveBeenCalledTimes(1);
  });

  it("getFreshPrices: engine down -> empty (every caller refuses to act), Neon's raw query never runs", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    queryRaw.mockResolvedValue([{ symbol: "XAUUSD", bid: new Prisma.Decimal("4500"), ask: new Prisma.Decimal("4500.2") }]);
    expect((await getFreshPrices(["XAUUSD"])).size).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("an engine answer with no row for the wanted symbol is 'no price', not a failure (no alert)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([engineRow("BTCUSD", "78000", "78010")]), { status: 200 }));
    const { rows, source } = await getLivePriceRowsWithSource(["XAUUSD"]);
    expect([source, rows.size]).toEqual(["vps", 0]);
    expect(findMany).not.toHaveBeenCalled();
    expect(notificationCreateMany).not.toHaveBeenCalled();
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
