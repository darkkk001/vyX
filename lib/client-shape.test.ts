import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { clientOrder, clientPosition, toClientShape } from "@/lib/client-execution";

// Client allow-list (owner 2026-10-23): no client route answer carries the broker's book, coverage, routing, desk mode,
// tenancy ids or staff identities.

vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const FORBIDDEN = ["createdByAdminId", "reviewedByAdminId", "markedByAdminId", "hiddenForPositionId", "bookType", "groupCategoryAtOpen", "covered", "autoHedged", "coveredAt", "coveragePositionId", "routing", "executionMode", "brokerId", "accountId", "deletedByAdminId", "deleteReason", "lastSwapAt", "reversedFromPositionId"];

/** Every key anywhere in a JSON value. */
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}
const D = (v: string | number) => new Prisma.Decimal(v);

describe("client allow-list (pure)", () => {
  const position = {
    id: "p1", brokerId: "b1", accountId: "a1", symbolId: "s1", originOrderId: "o1", ticket: 100, side: "BUY", volume: D("0.1"), openPrice: D("4029.76"),
    slPrice: null, tpPrice: null, status: "CLOSED", closePrice: D("4029.01"), realizedPnl: D("-0.75"), swap: D(0), commission: D(0), closedVolume: D("0.1"),
    closedSwap: null, initialVolume: D("0.1"), reversedFromPositionId: null, bookType: "B_BOOK", groupCategoryAtOpen: "B_BOOK", closedByAdminId: "adm_9",
    lastSwapAt: null, deletedAt: null, deletedByAdminId: null, deleteReason: null, openedAt: new Date(), closedAt: new Date(), covered: true, autoHedged: true,
    coveredAt: new Date(), coveragePositionId: "cov1", closePendingOrderId: null, symbol: { name: "XAUUSD", digits: 2 }, originOrder: { source: "WEB" },
  };
  const order = {
    id: "o1", brokerId: "b1", accountId: "a1", symbolId: "s1", side: "BUY", type: "MARKET", volume: D("0.1"), requestedPrice: D("4029.75"), slPrice: null, tpPrice: null,
    ticket: 7, status: "FILLED", filledPrice: D("4029.76"), filledAt: new Date(), rejectionReason: null, requotedPrice: null, idempotencyKey: "k", source: "WEB",
    closesPositionId: null, closeVolume: null, closeByPositionId: null, requestedAt: new Date(), executedAt: new Date(), clientIp: "203.0.113.9", platform: "WebTrader",
    routing: "B_BOOK", executionMode: "AUTO", createdAt: new Date(), updatedAt: new Date(),
  };

  it("a Position keeps what clients read and nothing internal; a staff close is a marker, not the staff id", () => {
    const c = clientPosition(position);
    for (const k of FORBIDDEN) expect(c).not.toHaveProperty(k);
    expect(c.closedByAdminId).toBe("staff");
    expect(c).toMatchObject({ id: "p1", ticket: 100, side: "BUY", status: "CLOSED", symbol: { name: "XAUUSD", digits: 2 }, originOrder: { source: "WEB" } });
  });

  it("an Order keeps the client's own IP, never a staff order's", () => {
    expect(clientOrder(order).clientIp).toBe("203.0.113.9");
    expect(clientOrder({ ...order, source: "ADMIN" })).not.toHaveProperty("clientIp");
    for (const k of FORBIDDEN) expect(clientOrder(order)).not.toHaveProperty(k);
    // owner 2026-10-26: a dealer's typed reject text never reaches the client, only its clientReason and sentence
    const rejected = clientOrder({ ...order, status: "REJECTED", executionMode: "DEALER", rejectionReason: "toxic flow, no live price for you" });
    expect(rejected).toMatchObject({ clientReason: "DEALER_REJECTED", rejectionReason: "Rejected by the dealer" });
    expect(rejected).not.toHaveProperty("executionMode");
    expect(clientOrder(order)).not.toHaveProperty("clientReason");
  });

  it("toClientShape cuts rows anywhere in an answer and keeps computed fields; a column added later is dropped", () => {
    const answer = { order, position: { ...position, closes: [{ volume: "0.1" }], openExecution: { filledPrice: "4029.76" }, someNewColumn: undefined }, balance: "999.25" };
    const shaped = toClientShape([answer, { ...position }]) as Array<Record<string, unknown>>;
    const keys = keysDeep(shaped);
    for (const k of FORBIDDEN) expect(keys.has(k)).toBe(false);
    expect((shaped[0].position as Record<string, unknown>).closes).toEqual([{ volume: "0.1" }]); // computed: kept
    expect((shaped[0].position as Record<string, unknown>).openExecution).toEqual({ filledPrice: "4029.76" });
    expect(shaped[0].balance).toBe("999.25");
  });
});

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "routing" FROM "Order" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/client-shape.test.ts: DB unreachable, skipping the route checks");
  }
});
const brokers: string[] = [];
afterAll(async () => {
  if (dbReachable && brokers.length) {
    const where = { brokerId: { in: brokers } };
    for (const m of ["rejectedOrder", "deal", "transaction", "auditLog", "position", "order", "account", "brokerSymbol", "group"] as const) {
      await (prisma[m] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where }).catch(() => {});
    }
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "CS" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "CS" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("client routes answer only allow-listed fields (live DB)", () => {
  it("POST /api/trade/orders (a fill), GET /api/trade/positions, GET /api/trade/orders, then the close and GET /api/trade/history (both views)", async () => {
    if (!dbReachable) return;
    const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
    const broker = await prisma.broker.create({ data: { name: `Client Shape ${sfx}`, subdomain: `cstest-${sfx}` } });
    brokers.push(broker.id);
    const symbol = await prisma.symbol.create({ data: { name: `CS${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", digits: 2 } });
    await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
    await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("99.90"), ask: D("100.10") } });
    const group = await prisma.group.create({ data: { brokerId: broker.id, name: `CS-${sfx}`, dealingMode: "AUTO" } });
    const account = await prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: `5${sfx.slice(0, 7)}`, email: `cs-${sfx}@test.local`, passwordHash: "x", fullName: "Client Shape", accountMode: "LIVE", balance: D(100000) } });
    const { getAccountSession } = await import("@/lib/account-auth");
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: account.id, brokerId: broker.id });
    const json = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`https://test.local${path}`, { headers: { "content-type": "application/json" }, ...init });
    const noForbidden = (label: string, body: unknown) => {
      const keys = keysDeep(body);
      for (const k of FORBIDDEN) expect(keys.has(k), `${label} carries ${k}`).toBe(false);
    };

    const orders = await import("@/app/api/trade/orders/route");
    const placed = await orders.POST(json("/api/trade/orders", { method: "POST", body: JSON.stringify({ symbol: symbol.name, side: "BUY", type: "MARKET", volume: "0.10", price: "100.10", idempotencyKey: `cs:${randomUUID()}` }) }));
    expect(placed.status).toBe(201);
    const placedBody = await placed.json();
    noForbidden("POST /api/trade/orders", placedBody);
    expect(placedBody.order).toMatchObject({ status: "FILLED", symbolId: symbol.id });

    const positions = await import("@/app/api/trade/positions/route");
    const open = await (await positions.GET()).json();
    noForbidden("GET /api/trade/positions", open);
    expect(open).toHaveLength(1);

    noForbidden("GET /api/trade/orders", await (await orders.GET(json("/api/trade/orders?status=all"))).json());

    const close = await import("@/app/api/trade/positions/[id]/close/route");
    const closed = await close.POST(json(`/api/trade/positions/${open[0].id}/close`, { method: "POST", body: JSON.stringify({ closePrice: "99.90", maxSlippagePips: "500" }) }), { params: Promise.resolve({ id: open[0].id }) });
    expect(closed.status).toBe(200);
    noForbidden("POST close", await closed.json());

    const history = await import("@/app/api/trade/history/route");
    for (const q of ["", "?closes=1"]) {
      const h = await (await history.GET(json(`/api/trade/history${q}`))).json();
      noForbidden(`GET /api/trade/history${q}`, h);
      expect(h).toHaveLength(1);
      expect(h[0]).toHaveProperty("openExecution");
    }
  }, 60000);
});
