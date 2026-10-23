import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Close and modify refusals (owner 2026-10-23, from the backoffice's USDX trace):
// - per-category price age (indices / energies 10 s, FX / metals 3 s, crypto 5 s); a little too old waits up to 1.5 s for
//   a fresh tick; > 60 s while the feed is alive is NOT_QUOTING; none of that is ever "market closed" to the client;
// - the client gets clientReason only, never the internal reason;
// - every refusal leaves a RejectedOrder row (kind CLOSE / MODIFY) with the internal reason and the last tick's age.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);
const INTERNAL = ["PRICE_STALE", "NOT_QUOTING", "NO_LIVE_FEED", "INSUFFICIENT_MARGIN", "SLIPPAGE_EXCEEDED", "PRICE_CHANGED", "lastTickAt", "lastTickAgeMs", "reference price"];
const CLIENT_KEYS = new Set(["error", "clientReason", "message", "nextOpenAt", "retryAfterSeconds", "orderId", "required", "available", "balance", "serverPrice"]);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "kind", "lastTickAgeMs" FROM "RejectedOrder" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("close/refusals.test.ts: DB (with the RejectedOrder close columns) unreachable, skipping");
  }
});

const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (dbReachable && brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.tradingSession.deleteMany({ where: { brokerSymbol: where } }).catch(() => {});
    for (const m of ["rejectedOrder", "notification", "auditLog", "deal", "transaction", "position", "order", "account", "brokerSymbol", "group"] as const) {
      await (prisma[m] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where }).catch(() => {});
    }
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

type Category = "INDICES" | "FOREX" | "CRYPTO" | "COMMODITIES" | "METALS";
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, openTime: "00:00", closeTime: "24:00" }));

/** A broker with one symbol of `category` whose last tick is `ageMs` old, and a second symbol ticking now (the feed is
 *  alive). Sessions all week, so the test never depends on the day it runs. */
async function fixture(category: Category, ageMs: number, sessions = ALL_WEEK) {
  const s = randomUUID().replace(/-/g, "").slice(0, 8);
  const broker = await prisma.broker.create({ data: { name: `RF ${s}`, subdomain: `rf-${s}`, dealingModeAt: null } });
  brokers.push(broker.id);
  const mk = async (name: string, cat: Category, tickAt: Date) => {
    const sym = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: cat, digits: 2, contractSize: D(1) } });
    symbols.push(name);
    const bs = await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
    for (const t of sessions) await prisma.tradingSession.create({ data: { brokerSymbolId: bs.id, ...t } });
    await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt } });
    return sym;
  };
  const sym = await mk(`RF${s.toUpperCase()}`, category, new Date(Date.now() - ageMs));
  await mk(`RA${s.toUpperCase()}`, "FOREX", new Date()); // the feed is alive elsewhere
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `RF-${s}`, dealingMode: "AUTO" } });
  const account = await prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: `6${s.slice(0, 7)}`, email: `rf-${s}@test.local`, passwordHash: "x", fullName: "RF", accountMode: "LIVE", balance: D(10000) } });
  const order = await prisma.order.create({ data: { brokerId: broker.id, accountId: account.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(90), idempotencyKey: `rf:${randomUUID()}`, status: "FILLED", filledPrice: D(90), filledAt: new Date() } });
  const position = await prisma.position.create({ data: { brokerId: broker.id, accountId: account.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(90) } });
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: account.id, brokerId: broker.id } as never);
  return { broker, account, sym, position };
}

async function close(positionId: string) {
  const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
  const t0 = Date.now();
  const res = await POST(new NextRequest(`https://t.local/api/trade/positions/${positionId}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ closePrice: "100.00", maxSlippagePips: "unlimited" }) }), { params: Promise.resolve({ id: positionId }) });
  return { status: res.status, json: await res.json(), ms: Date.now() - t0 };
}

/** The client answer carries only allow-listed keys and no internal reason anywhere. */
function clientOnly(body: Record<string, unknown>) {
  for (const k of Object.keys(body)) expect(CLIENT_KEYS.has(k), `client answer carries "${k}"`).toBe(true);
  const text = JSON.stringify(body);
  for (const word of INTERNAL) expect(text, `client answer contains ${word}`).not.toContain(word);
}
const traced = (positionId: string) => prisma.rejectedOrder.findMany({ where: { positionId } });

describe("close: price age per category, never 'market closed' for an open market", () => {
  it("an index tick 5 s old is fresh enough (10 s limit): the close fills", async () => {
    if (!dbReachable) return;
    const { position } = await fixture("INDICES", 5_000);
    const r = await close(position.id);
    expect(r.status).toBe(200);
  });

  it("an FX tick 5 s old (3 s limit) and no fresh tick: waits ~1.5 s, then OFF_QUOTES; traced as PRICE_STALE with the tick's age", async () => {
    if (!dbReachable) return;
    const { position } = await fixture("FOREX", 5_000);
    const r = await close(position.id);
    expect(r.status).toBe(400);
    expect(r.ms).toBeGreaterThanOrEqual(1_200);
    expect(r.json).toMatchObject({ clientReason: "OFF_QUOTES", error: "Off quotes - try again" });
    clientOnly(r.json);
    const rows = await traced(position.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "CLOSE", reason: "PRICE_STALE", clientReason: "OFF_QUOTES", side: "BUY", volume: "1" });
    expect(rows[0].lastTickAgeMs).toBeGreaterThanOrEqual(5_000);
  });

  it("a fresh tick arriving during the wait is used: the close fills", async () => {
    if (!dbReachable) return;
    const { position, sym } = await fixture("INDICES", 20_000);
    // a Prisma query only runs once something awaits it (.then): `void prisma...update()` would never execute
    setTimeout(() => prisma.livePrice.update({ where: { symbol: sym.name }, data: { tickAt: new Date() } }).then(() => undefined), 400);
    const r = await close(position.id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  it("the USDX case: no tick for 90 s while the feed is alive -> OFF_QUOTES (never MARKET_CLOSED); traced as NOT_QUOTING", async () => {
    if (!dbReachable) return;
    const { position } = await fixture("INDICES", 90_000);
    const r = await close(position.id);
    expect(r.status).toBe(400);
    expect(r.ms).toBeLessThan(1_000); // past 60 s there is nothing to wait for
    expect(r.json.clientReason).toBe("OFF_QUOTES");
    expect(JSON.stringify(r.json)).not.toContain("MARKET_CLOSED");
    clientOnly(r.json);
    expect((await traced(position.id))[0]).toMatchObject({ kind: "CLOSE", reason: "NOT_QUOTING", clientReason: "OFF_QUOTES" });
  });

  it("closed by its schedule: MARKET_CLOSED with the reopen time", async () => {
    if (!dbReachable) return;
    const now = new Date();
    const tomorrow = (now.getUTCDay() + 1) % 7;
    const { position } = await fixture("INDICES", 1_000, [{ dayOfWeek: tomorrow, openTime: "00:00", closeTime: "24:00" }]);
    const r = await close(position.id);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "MARKET_CLOSED", clientReason: "MARKET_CLOSED", message: "Market closed" });
    expect(typeof r.json.nextOpenAt).toBe("string");
    clientOnly(r.json);
    expect((await traced(position.id))[0]).toMatchObject({ kind: "CLOSE", reason: "MARKET_CLOSED", clientReason: "MARKET_CLOSED" });
  });
});

describe("modify refusals", () => {
  it("a wrong-side SL: INVALID_SLTP to the client, traced as MODIFY with the internal text", async () => {
    if (!dbReachable) return;
    const { position } = await fixture("FOREX", 0);
    const { PATCH } = await import("@/app/api/trade/positions/[id]/route");
    const res = await PATCH(new NextRequest(`https://t.local/api/trade/positions/${position.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ slPrice: "150" }) }), { params: Promise.resolve({ id: position.id }) });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ clientReason: "INVALID_SLTP", error: "Invalid SL or TP" });
    clientOnly(body);
    const row = (await traced(position.id))[0];
    expect(row).toMatchObject({ kind: "MODIFY", clientReason: "INVALID_SLTP" });
    expect(row.reason).toMatch(/SL must be below/);
  });

  it("bulk modify: each refused row carries clientReason only, and each is traced", async () => {
    if (!dbReachable) return;
    const { position } = await fixture("FOREX", 0);
    const { POST } = await import("@/app/api/trade/positions/modify-bulk/route");
    const res = await POST(new NextRequest("https://t.local/api/trade/positions/modify-bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ positionIds: [position.id], sl: { price: "150" } }) }));
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ positionId: position.id, ok: false, clientReason: "INVALID_SLTP" });
    expect(JSON.stringify(body)).not.toMatch(/reference price/);
    expect((await traced(position.id))[0]).toMatchObject({ kind: "MODIFY", clientReason: "INVALID_SLTP" });
  });
});
