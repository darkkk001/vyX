import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Order sounds by origin (owner 2026-11-13, option C). Two clients (A, B) signed into ONE account. Every event a client's request causes carries
// that client's id; the automatic events carry the id the row stored when a client set it (SL / TP -> Position.slTpClientInstance, a pending
// order -> Order.clientInstance). A request without the header, staff, engine: no id, silent everywhere. The event recorder below runs the real
// stamping (lib/client-origin.ts stampOrigin), exactly what publishTradingEvent sends to the gateway.
const session = vi.hoisted(() => ({ current: { accountId: "", brokerId: "" } }));
const published = vi.hoisted(() => [] as { type: string; payload: Record<string, unknown> }[]);
vi.mock("@/lib/account-auth", () => ({ getAccountSession: async () => session.current }));
vi.mock("@/lib/nats", async () => {
  const { stampOrigin } = await import("@/lib/client-origin");
  return { publishTradingEvent: vi.fn(async (type: string, payload: Record<string, unknown>) => { published.push({ type, payload: stampOrigin(payload) }); }) };
});

const D = (v: string | number) => new Prisma.Decimal(v);
const A = "clientAAAA1111aaaa";
const B = "clientBBBB2222bbbb";
let dbReachable = false;
const createdBrokerIds: string[] = [];

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("sound-origin.test.ts: DB unreachable, skipping"); }
});
beforeEach(() => { published.length = 0; });

async function fixture() {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Origin ${s}`, subdomain: `orig-${s}` } });
  createdBrokerIds.push(broker.id);
  const symbol = await prisma.symbol.create({ data: { name: `OS${s.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", digits: 2 } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("99.90"), ask: D("100.10") } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `OG-${s}`, dealingMode: "AUTO" } });
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: `8${s.slice(0, 7)}`, email: `orig-${s}@test.local`, passwordHash: "x", fullName: "Origin Test", accountMode: "LIVE", balance: D(100000) },
  });
  session.current = { accountId: account.id, brokerId: broker.id };
  return { accountId: account.id, symbolName: symbol.name };
}

async function call(path: string, method: string, body: unknown, client: string | null, handler: (req: NextRequest, ctx?: never) => Promise<Response>, ctx?: unknown) {
  const req = new NextRequest(`https://test.local${path}`, {
    method, headers: { "content-type": "application/json", ...(client ? { "x-client-instance": client } : {}) }, body: JSON.stringify(body),
  });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, ctx);
  return { status: res.status, json: await res.json() };
}
const ev = (type: string) => published.filter((e) => e.type === type).map((e) => e.payload);

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    for (const t of ["deal", "auditLog", "notification", "transaction", "position", "order", "account", "brokerSymbol", "group"] as const) {
      await (prisma[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where }).catch(() => {});
    }
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } }).catch(() => {});
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "OS" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "OS" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("order sounds by origin (live DB)", () => {
  it("a market order from client A: the order, the position and its fill event name A; B is named nowhere", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { POST } = await import("./route");
    const r = await call("/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.01", price: "100.10", slPrice: "90.00", idempotencyKey: `o:${randomUUID()}` }, A, POST as never);
    expect(r.status).toBe(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.json.order.id } });
    const pos = await prisma.position.findUniqueOrThrow({ where: { id: r.json.position.id } });
    expect(order.clientInstance).toBe(A);
    expect(pos.openClientInstance).toBe(A);
    expect(pos.slTpClientInstance).toBe(A);
    expect(ev("OrderFilled").map((p) => p.origin_client_id)).toEqual([A]);
  });

  it("B moves the SL of A's position: the levels are B's, and when the SL hits only B is named", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { POST } = await import("./route");
    const placed = await call("/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.01", price: "100.10", idempotencyKey: `o:${randomUUID()}` }, A, POST as never);
    const positionId = placed.json.position.id as string;
    expect((await prisma.position.findUniqueOrThrow({ where: { id: positionId } })).slTpClientInstance).toBeNull();   // no SL / TP yet: nobody's
    const { PATCH } = await import("../positions/[id]/route");
    published.length = 0;
    const m = await call(`/api/trade/positions/${positionId}`, "PATCH", { slPrice: "95.00" }, B, PATCH as never, { params: Promise.resolve({ id: positionId }) });
    expect(m.status).toBe(200);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: positionId } })).slTpClientInstance).toBe(B);
    expect(ev("PositionModified").every((p) => p.origin_client_id === B)).toBe(true);
    // the price falls through the SL; the risk pass (no client request in progress) closes it and names the setter, B
    published.length = 0;
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D("94.00"), ask: D("94.20"), updatedAt: new Date() } });
    const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
    await evaluateAccountRisk(fx.accountId, undefined, "unknown");
    const closed = ev("PositionClosed").filter((p) => p.position_id === positionId);
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.some((p) => p.origin_client_id === B)).toBe(true);
    expect(closed.some((p) => p.origin_client_id === A)).toBe(false);
  });

  it("a pending order placed by A fills on its trigger with A named, though no client request is in progress", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { POST } = await import("./route");
    const placed = await call("/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "LIMIT", volume: "0.01", price: "95.00", idempotencyKey: `o:${randomUUID()}` }, A, POST as never);
    expect(placed.status).toBe(201);
    const orderId = (placed.json.order?.id ?? placed.json.id) as string;
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).clientInstance).toBe(A);
    published.length = 0;
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D("94.80"), ask: D("94.90"), updatedAt: new Date() } });
    const { evaluatePendingTriggers } = await import("@/lib/pending-trigger");
    await evaluatePendingTriggers([fx.symbolName]);
    const filled = ev("OrderFilled").filter((p) => p.order_id === orderId);
    expect(filled.length).toBe(1);
    expect(filled[0].origin_client_id).toBe(A);
    const pos = await prisma.position.findFirstOrThrow({ where: { originOrderId: orderId } });
    expect(pos.openClientInstance).toBe(A);
  });

  it("a request without the header (an older client, a script) names nobody: its events stay silent everywhere", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { POST } = await import("./route");
    const r = await call("/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.01", price: "100.10", idempotencyKey: `o:${randomUUID()}` }, null, POST as never);
    expect(r.status).toBe(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: r.json.order.id } })).clientInstance).toBeNull();
    expect(ev("OrderFilled").every((p) => !("origin_client_id" in p))).toBe(true);
  });

  it("a malformed header is ignored, never stored or echoed", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { POST } = await import("./route");
    const r = await call("/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.01", price: "100.10", idempotencyKey: `o:${randomUUID()}` }, "<script>x</script>", POST as never);
    expect(r.status).toBe(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: r.json.order.id } })).clientInstance).toBeNull();
  });
});
