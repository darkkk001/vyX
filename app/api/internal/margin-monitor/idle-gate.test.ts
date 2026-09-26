// The margin-monitor full pass's idle gate (Neon load, 2026-09-26): with no fresh tick on any symbol the route answers
// from the engine's tick cache alone and touches no database. The engine's reply is stubbed here; with the
// statement-counting proxy (DATABASE_URL through 127.0.0.1:5599) the test also proves zero statements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { NextRequest } from "next/server";

const vps = vi.hoisted(() => ({ rows: null as null | { symbol: string; bid: string; ask: string; tickAt: string; updatedAt: string; ageMs: number }[] }));
vi.mock("@/lib/market-data-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/market-data-client")>()),
  fetchVpsPrices: async () => vps.rows,
  fetchVpsPrice: async () => null,
}));

import { GET } from "./route";

const PROXIED = (process.env.DATABASE_URL ?? "").includes("127.0.0.1:5599");
function statements(cmd: "get" | "reset"): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.connect(5600, "127.0.0.1", () => s.write(cmd));
    let out = "";
    s.on("data", (d) => (out += d.toString()));
    s.on("end", () => resolve(Number(out)));
    s.on("error", reject);
  });
}

const row = (symbol: string, ageSecs: number) => {
  const t = new Date(Date.now() - ageSecs * 1000).toISOString();
  return { symbol, bid: "1", ask: "1.1", tickAt: t, updatedAt: new Date().toISOString(), ageMs: ageSecs * 1000 };
};
const call = () => GET(new NextRequest("http://x/api/internal/margin-monitor", { headers: { authorization: "Bearer idle-gate-secret" } }));

describe("margin-monitor full pass: idle gate", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "idle-gate-secret");
    vi.stubEnv("MARKET_DATA_PRICES", "vps");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vps.rows = null;
  });

  it("a closed market (every tick older than 15 s) returns at once with no database work", async () => {
    vps.rows = [row("XAUUSD", 40 * 3600), row("EURUSD", 16)];
    if (PROXIED) await statements("reset");
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ skipped: "no fresh price on any symbol", accountsEvaluated: 0 });
    if (PROXIED) expect(await statements("get")).toBe(0);
  });

  it("one fresh symbol anywhere runs the pass as before", async () => {
    vps.rows = [row("XAUUSD", 40 * 3600), row("BTCUSD", 2)];
    const body = await (await call()).json();
    expect(body.skipped).toBeUndefined();
    expect(body).toHaveProperty("outbox");
  });

  it("the engine unreachable (unknown) runs the pass as before, never skips blind", async () => {
    vps.rows = null;
    const body = await (await call()).json();
    expect(body.skipped).toBeUndefined();
  });

  it("not on the VPS price source: the gate is off", async () => {
    vi.stubEnv("MARKET_DATA_PRICES", "");
    vps.rows = [row("XAUUSD", 40 * 3600)];
    const body = await (await call()).json();
    expect(body.skipped).toBeUndefined();
  });
});
