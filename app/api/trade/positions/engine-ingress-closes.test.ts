import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// The engine ingress for CLOSES (owner 2026-11-12, lib/engine-ingress.ts): a designated account's close and bulk close
// go to the gateway -> engine; every other account stays on the web path; any failure but a 409 falls back to the web
// path, which closes ONLY what is still open. The real routes against a live DB, with the gateway faked by a fetch stub
// that can play the engine (close a position in the DB) before it answers -- or before it loses the answer.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn(), ACCOUNT_SESSION_COOKIE_NAME: "vyx_trade_session" }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
const jar = vi.hoisted(() => ({ token: "app-token" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  // the QoreTrader app's transport: a bearer header, never the cookie
  headers: async () => ({ get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${jar.token}` : null) }),
}));

// The module reads its scope once at import, as in production: the designated ids are fixed before the first import.
const RUN = randomUUID().replace(/-/g, "").slice(0, 8);
const INGRESS_IDS = Array.from({ length: 8 }, (_, i) => `ingr${RUN}${i}`);
let nextIngress = 0;
process.env.ENGINE_INGRESS_ACCOUNT_IDS = INGRESS_IDS.join(",");
process.env.ENGINE_INGRESS_GATEWAY_URL = "https://feed.example";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("engine-ingress-closes.test.ts: DB unreachable, skipping");
  }
});

type Fx = { brokerId: string; accountId: string; symbolId: string; symbolName: string };
const brokers: string[] = [];

async function fixture(ingress: boolean): Promise<Fx> {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Ingress Close ${s}`, subdomain: `ictest-${s}` } });
  brokers.push(broker.id);
  const symbol = await prisma.symbol.create({ data: { name: `IC${s.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `IC-${s}`, category: "B_BOOK" } });
  const account = await prisma.account.create({
    data: {
      ...(ingress ? { id: INGRESS_IDS[nextIngress++] } : {}),
      groupId: group.id, brokerId: broker.id, accountNumber: `8${s.slice(0, 7)}`, email: `ic-${s}@test.local`, passwordHash: "x",
      fullName: "Ingress Close Client", accountMode: "DEMO", balance: D(10000),
    },
  });
  return { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function openPosition(fx: Fx, volume = "1.00") {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(volume), requestedPrice: D("90.00"), idempotencyKey: `ic-open:${randomUUID()}`, status: "FILLED", filledPrice: D("90.00"), filledAt: new Date() },
  });
  return prisma.position.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side: "BUY", volume: D(volume), openPrice: D("90.00") } });
}

/** What the engine does to a position on a close, as far as these tests look: CLOSED at a marker price. */
const engineCloses = (id: string) => prisma.position.update({ where: { id }, data: { status: "CLOSED", closePrice: D("77.77"), closedAt: new Date() } });

type Call = { url: string; auth: string | null; body: Record<string, unknown> };
function gateway(play: (call: Call) => Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), auth: new Headers(init.headers).get("cookie"), body: JSON.parse(String(init.body)) };
    calls.push(call);
    return play(call);
  });
  return calls;
}

async function as(fx: Fx) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
}
async function closeOne(fx: Fx, id: string, body: Record<string, unknown> = { closePrice: "100.00" }) {
  await as(fx);
  const { POST } = await import("./[id]/close/route");
  const res = await POST(new NextRequest(`https://test.local/api/trade/positions/${id}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: res.status, json: await res.json() };
}
async function closeBulk(fx: Fx, body: Record<string, unknown>) {
  await as(fx);
  const { POST } = await import("./close-bulk/route");
  const res = await POST(new NextRequest("https://test.local/api/trade/positions/close-bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
const statusOf = async (id: string) => (await prisma.position.findUniqueOrThrow({ where: { id } })).status;
const pnlRows = (id: string) => prisma.transaction.count({ where: { referenceType: "Position", referenceId: id, type: "TRADE_PNL" } });

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where });
  await prisma.deal.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where });
  await prisma.position.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.brokerSymbol.deleteMany({ where });
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "IC" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "IC" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("single close through the engine", () => {
  it("a designated account's full close goes to the gateway with the app's bearer session; the web path writes nothing", async () => {
    if (!dbReachable) return;
    const fx = await fixture(true);
    const p = await openPosition(fx);
    const calls = gateway(async () => {
      await engineCloses(p.id);
      return Response.json({ position: { id: p.id, status: "CLOSED", closePrice: "77.77" }, transaction: null, partial: false, balance: "9987.77" });
    });
    const r = await closeOne(fx, p.id, { closePrice: "100.00", maxSlippagePoints: "unlimited", idempotencyKey: "k-1" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ executedBy: "engine", balance: "9987.77" });
    expect(calls).toEqual([{ url: `https://feed.example/v1/positions/${p.id}/close`, auth: "vyx_trade_session=app-token", body: { closePrice: "100.00", maxSlippagePoints: "unlimited", idempotencyKey: "k-1" } }]);
    expect(await pnlRows(p.id)).toBe(0); // the web's closePositionInTx never ran
  });

  it("a 503 / 403 from the gateway: the web path closes it, once", async () => {
    if (!dbReachable) return;
    for (const status of [503, 403]) {
      const fx = await fixture(true);
      const p = await openPosition(fx);
      gateway(async () => Response.json({ error: "refused" }, { status }));
      const r = await closeOne(fx, p.id);
      expect(r.status, String(status)).toBe(200);
      expect(r.json.executedBy).toBeUndefined();
      expect(await statusOf(p.id)).toBe("CLOSED");
      expect(await pnlRows(p.id)).toBe(1);
    }
  });

  it("a lost answer after the engine closed it: the web path does NOT close it again (409, no web ledger row)", async () => {
    if (!dbReachable) return;
    const fx = await fixture(true);
    const p = await openPosition(fx);
    gateway(async () => {
      await engineCloses(p.id);
      throw new Error("The operation was aborted"); // the timeout
    });
    const r = await closeOne(fx, p.id);
    expect(r.status).toBe(409);
    expect(await pnlRows(p.id)).toBe(0);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p.id } })).closePrice?.toString()).toBe("77.77");
  });

  it("a 409 from the engine is the answer", async () => {
    if (!dbReachable) return;
    const fx = await fixture(true);
    const p = await openPosition(fx);
    gateway(async () => Response.json({ error: "position was already closed" }, { status: 409 }));
    expect((await closeOne(fx, p.id)).status).toBe(409);
    expect(await statusOf(p.id)).toBe("OPEN");
  });

  it("a partial close and an STM bulk close stay on the web path; so does every other account", async () => {
    if (!dbReachable) return;
    const fx = await fixture(true);
    const partial = await openPosition(fx);
    const stm = await openPosition(fx);
    const calls = gateway(async () => Response.json({}, { status: 500 }));
    expect((await closeOne(fx, partial.id, { closePrice: "100.00", volume: "0.40" })).status).toBe(200);
    expect((await closeOne(fx, stm.id, { closePrice: "100.00", source: "stm_bulk" })).status).toBe(200);
    const other = await fixture(false);
    const q = await openPosition(other);
    expect((await closeOne(other, q.id)).status).toBe(200);
    expect(calls).toEqual([]);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: partial.id } })).volume.toString()).toBe("0.6");
    expect(await statusOf(stm.id)).toBe("CLOSED");
    expect(await statusOf(q.id)).toBe("CLOSED");
  });
});

describe("bulk close through the engine", () => {
  it("a designated account's basket goes to /v1/positions/close-bulk in one call; the web path writes nothing", async () => {
    if (!dbReachable) return;
    const fx = await fixture(true);
    const a = await openPosition(fx);
    const b = await openPosition(fx);
    const calls = gateway(async () => {
      await engineCloses(a.id);
      await engineCloses(b.id);
      return Response.json({ requested: 2, successful: 2, failed: 0, results: [{ positionId: a.id, closed: true }, { positionId: b.id, closed: true }] });
    });
    const r = await closeBulk(fx, { scope: "ALL", positionIds: [a.id, b.id] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ requested: 2, successful: 2, executedBy: "engine" });
    expect(calls).toEqual([{ url: "https://feed.example/v1/positions/close-bulk", auth: "vyx_trade_session=app-token", body: { scope: "ALL", positionIds: [a.id, b.id] } }]);
    expect(await pnlRows(a.id)).toBe(0);
    expect(await pnlRows(b.id)).toBe(0);
  });

  it("a lost answer after the engine closed part of the basket: the web path closes ONLY what is still open", async () => {
    if (!dbReachable) return;
    const fx = await fixture(true);
    const done = await openPosition(fx);
    const left = await openPosition(fx);
    gateway(async () => {
      await engineCloses(done.id);
      throw new Error("The operation was aborted");
    });
    const r = await closeBulk(fx, { scope: "ALL" });
    expect(r.status).toBe(200);
    expect(r.json.executedBy).toBeUndefined();
    expect(r.json.results.map((x: { positionId: string }) => x.positionId)).toEqual([left.id]);
    expect(await pnlRows(done.id)).toBe(0); // not closed twice
    expect(await pnlRows(left.id)).toBe(1);
    expect(await statusOf(left.id)).toBe("CLOSED");
  });

  it("a 503 from the gateway: the web path closes the basket", async () => {
    if (!dbReachable) return;
    const fx = await fixture(true);
    const a = await openPosition(fx);
    gateway(async () => Response.json({ error: "x" }, { status: 503 }));
    const r = await closeBulk(fx, { scope: "ALL" });
    expect(r.json).toMatchObject({ requested: 1, successful: 1 });
    expect(await pnlRows(a.id)).toBe(1);
  });

  it("an STM bulk close and every other account never call the gateway", async () => {
    if (!dbReachable) return;
    const calls = gateway(async () => Response.json({}, { status: 500 }));
    const fx = await fixture(true);
    await openPosition(fx);
    expect((await closeBulk(fx, { scope: "ALL", source: "stm_bulk" })).json).toMatchObject({ successful: 1 });
    const other = await fixture(false);
    await openPosition(other);
    expect((await closeBulk(other, { scope: "ALL" })).json).toMatchObject({ successful: 1 });
    expect(calls).toEqual([]);
  });
});
