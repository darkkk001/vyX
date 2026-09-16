import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Route-contract test: auth (role set matches dealing-desk), param
// validation, and passthrough of the shared candle read. The data read
// itself (fetchCandleHistory) is covered where it lives (lib/candles.ts +
// the trade route); here it's mocked so the test is deterministic and
// needs no DB or VPS env. Session is read via next/headers, so
// getAdminSession is mocked (same shape as other manage route tests).
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

vi.mock("@/lib/candles", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/candles")>();
  return { ...actual, fetchCandleHistory: vi.fn() };
});

const SAMPLE = [
  { bucketStart: "2026-09-16T10:00:00.000Z", open: 4456.2, high: 4457.0, low: 4455.8, close: 4456.5 },
  { bucketStart: "2026-09-16T11:00:00.000Z", open: 4456.5, high: 4458.1, low: 4456.1, close: 4457.9 },
];

async function call(url: string, session: { adminId: string; role: string; brokerId: string | null } | null) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue(session as never);
  const { fetchCandleHistory } = await import("@/lib/candles");
  vi.mocked(fetchCandleHistory).mockResolvedValue({ candles: SAMPLE, source: "neon" });
  const { GET } = await import("./route");
  const response = await GET(new NextRequest(url));
  return { status: response.status, header: response.headers.get("x-market-data-source"), json: await response.json() };
}

const admin = { adminId: "a1", role: "MANAGER" as const, brokerId: "b1" };

describe("GET /api/manage/candles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403 when not signed in", async () => {
    const r = await call("https://test.local/api/manage/candles?symbol=XAUUSD&tf=H1", null);
    expect(r.status).toBe(403);
  });

  it("403 for a role outside MANAGER/BROKER_ADMIN", async () => {
    const r = await call("https://test.local/api/manage/candles?symbol=XAUUSD&tf=H1", { adminId: "s", role: "SUPER_ADMIN", brokerId: "b1" });
    expect(r.status).toBe(403);
  });

  it("403 for an admin with no broker", async () => {
    const r = await call("https://test.local/api/manage/candles?symbol=XAUUSD&tf=H1", { ...admin, brokerId: null });
    expect(r.status).toBe(403);
  });

  it("400 when symbol is missing", async () => {
    const r = await call("https://test.local/api/manage/candles?tf=H1", admin);
    expect(r.status).toBe(400);
  });

  it("400 for an invalid timeframe", async () => {
    const r = await call("https://test.local/api/manage/candles?symbol=XAUUSD&tf=H3", admin);
    expect(r.status).toBe(400);
  });

  it("200 returns the OHLC array and the market-data-source header", async () => {
    const r = await call("https://test.local/api/manage/candles?symbol=XAUUSD&tf=H1", admin);
    expect(r.status).toBe(200);
    expect(r.header).toBe("neon");
    expect(r.json).toEqual(SAMPLE);
  });
});
