import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { fetchVpsCandles, isVpsSymbol, toPrismaCandle } from "./market-data-client";

// What the engine's GET /internal/candles emits (engine/server/src/main.rs
// internal_candles) -- string decimals, ISO-8601 with milliseconds.
const engineRow = {
  symbol: "EURUSD",
  timeframe: "M1",
  bucketStart: "2026-09-14T18:20:00.000Z",
  open: "1.15579",
  high: "1.1558",
  low: "1.15571",
  close: "1.15575",
  updatedAt: "2026-09-14T18:21:03.521Z",
};

describe("toPrismaCandle", () => {
  it("maps the engine wire row to the Prisma Candle runtime row (Decimal + Date + enum)", () => {
    const row = toPrismaCandle(engineRow)!;
    expect(row).not.toBeNull();
    expect(row.timeframe).toBe("M1");
    expect(row.bucketStart).toBeInstanceOf(Date);
    expect(row.bucketStart.toISOString()).toBe("2026-09-14T18:20:00.000Z");
    expect(row.open).toBeInstanceOf(Prisma.Decimal);
    expect(row.high.toString()).toBe("1.1558");
    expect(row.close.equals(new Prisma.Decimal("1.15575"))).toBe(true);
  });

  it("serialises exactly like a Prisma row would (the chart sees no difference)", () => {
    // NextResponse.json(prismaRows) turns Decimal -> string and Date -> ISO ms;
    // the mapped row must round-trip to the same JSON the engine sent.
    const json = JSON.parse(JSON.stringify(toPrismaCandle(engineRow)));
    expect(json).toEqual(engineRow);
  });

  it("refuses rows that would corrupt a chart", () => {
    expect(toPrismaCandle({ ...engineRow, timeframe: "M2" })).toBeNull();
    expect(toPrismaCandle({ ...engineRow, open: "abc" })).toBeNull();
    expect(toPrismaCandle({ ...engineRow, bucketStart: "yesterday" })).toBeNull();
  });
});

describe("isVpsSymbol", () => {
  const saved = process.env.MARKET_DATA_VPS_SYMBOLS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MARKET_DATA_VPS_SYMBOLS;
    else process.env.MARKET_DATA_VPS_SYMBOLS = saved;
  });
  it("is off when unset, per-symbol when listed, everything with *", () => {
    delete process.env.MARKET_DATA_VPS_SYMBOLS;
    expect(isVpsSymbol("EURUSD")).toBe(false);
    process.env.MARKET_DATA_VPS_SYMBOLS = " eurusd, XAUUSD ";
    expect(isVpsSymbol("EURUSD")).toBe(true);
    expect(isVpsSymbol("XAUUSD")).toBe(true);
    expect(isVpsSymbol("BTCUSD")).toBe(false);
    process.env.MARKET_DATA_VPS_SYMBOLS = "*";
    expect(isVpsSymbol("BTCUSD")).toBe(true);
  });
});

describe("fetchVpsCandles", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.MARKET_DATA_URL = "https://feed.example.test/";
    process.env.MARKET_DATA_READ_SECRET = "read-secret";
  });
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("calls /internal/candles with the read-only header and maps the rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([engineRow]), { status: 200, headers: { "content-type": "application/json" } })
    );
    const rows = await fetchVpsCandles("EURUSD", "M1", 300);
    expect(rows).toHaveLength(1);
    expect(rows![0].open.toString()).toBe("1.15579");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://feed.example.test/internal/candles?symbol=EURUSD&tf=M1&limit=300");
    expect((init as RequestInit).headers).toEqual({ "X-Market-Data-Secret": "read-secret" });
  });

  it("returns null (= use Neon) on a non-2xx, a bad body, an empty body, or a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 401 }));
    expect(await fetchVpsCandles("EURUSD", "M1")).toBeNull();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: "x" }), { status: 200 }));
    expect(await fetchVpsCandles("EURUSD", "M1")).toBeNull();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("[]", { status: 200 }));
    expect(await fetchVpsCandles("EURUSD", "M1")).toBeNull();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await fetchVpsCandles("EURUSD", "M1")).toBeNull();
  });

  it("is inert without a URL or a secret", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    delete process.env.MARKET_DATA_READ_SECRET;
    expect(await fetchVpsCandles("EURUSD", "M1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
