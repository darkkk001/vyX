import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Latency fixes 1 + 2 (2026-09-26, docs/audit/2026-09-24/latency-contract.md), on the local scratch DB, own cleanup:
// the 2xx body and the trading event both carry the position (+ balance), the event is published before the
// follow-through (mirror / dealer feed), and each route answers with Server-Timing.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
const calls: string[] = [];
vi.mock("@/lib/nats", () => ({
  publishTradingEvent: vi.fn(async (type: string) => {
    calls.push(`publish:${type}`);
  }),
  publishAlertConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/dealer-activity", () => ({
  recordDealerActivity: vi.fn(async () => {
    calls.push("dealerActivity");
  }),
}));

import { publishTradingEvent } from "@/lib/nats";
import { getAccountSession } from "@/lib/account-auth";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("latency-contract.test.ts: DB unreachable, skipping");
  }
});
beforeEach(() => {
  calls.length = 0;
  vi.mocked(publishTradingEvent).mockClear();
});

const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.groupSymbolConfig.deleteMany({ where: { group: { brokerId: { in: brokers } } } }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

async function fixture(commission: number) {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `LC ${sfx}`, subdomain: `lc-${sfx}`, pricingEngineEnabled: true, dealingModeAt: null } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `LC${sfx.toUpperCase()}`, baseCurrency: "XAU", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D("4456.35"), ask: D("4456.53"), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `LC-${sfx}`, leverage: 100, dealingMode: "AUTO" } });
  if (commission > 0) await prisma.groupSymbolConfig.create({ data: { groupId: g.id, symbolId: sym.id, commissionPerLot: D(commission) } });
  const n = `4${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "4")}`;
  const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `lc-${n}@test.local`, passwordHash: "x", fullName: "LC", accountMode: "LIVE", balance: D(10000), leverage: 100 } });
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b.id } as never);
  return { symbolName: sym.name, accountId: acc.id };
}
const req = (url: string, method: string, body: unknown) =>
  new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json", "x-client-platform": "DESKTOP_NATIVE" }, body: JSON.stringify(body) });
const eventOf = (type: string) => vi.mocked(publishTradingEvent).mock.calls.find((c) => c[0] === type)?.[1] as Record<string, unknown> | undefined;

describe("latency contract: position in the body AND the event", () => {
  it("market BUY with commission: 201 body + OrderFilled carry the full position and the balance after the commission", async () => {
    if (!dbReachable) return;
    const fx = await fixture(7);
    const { POST } = await import("@/app/api/trade/orders/route");
    const res = await POST(req("/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "1", price: "4456.53", idempotencyKey: randomUUID() }));
    expect(res.status).toBe(201);
    expect(res.headers.get("server-timing")).toMatch(/^app;dur=\d+$/);
    const body = await res.json();
    const dbPos = await prisma.position.findUniqueOrThrow({ where: { id: body.position.id } });
    expect(body.position).toMatchObject({ id: dbPos.id, ticket: dbPos.ticket, side: "BUY", status: "OPEN", symbol: { name: fx.symbolName, digits: 2 }, originOrder: { source: "DESKTOP_NATIVE" }, closePendingOrder: null });
    expect(Number(body.position.commission)).toBe(7);
    expect(Number(dbPos.commission)).toBe(7);
    expect(body.balance).toBe("9993");
    const ev = eventOf("OrderFilled")!;
    expect(ev.position_id).toBe(dbPos.id);
    expect((ev.position as { id: string }).id).toBe(dbPos.id);
    expect(ev.balance).toBe("9993");
    // the trader's event goes out before the dealer-feed follow-through
    expect(calls.indexOf("publish:OrderFilled")).toBeLessThan(calls.indexOf("dealerActivity"));
  });

  it("market BUY without commission: no balance field (the balance did not move)", async () => {
    if (!dbReachable) return;
    const fx = await fixture(0);
    const { POST } = await import("@/app/api/trade/orders/route");
    const res = await POST(req("/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.1", price: "4456.53", idempotencyKey: randomUUID() }));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.balance).toBeUndefined();
    expect(eventOf("OrderFilled")!.balance).toBeUndefined();
  });

  it("SL/TP modify: the updated row in the body and in PositionModified", async () => {
    if (!dbReachable) return;
    const fx = await fixture(0);
    const orders = await import("@/app/api/trade/orders/route");
    const opened = await (await orders.POST(req("/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.1", price: "4456.53", idempotencyKey: randomUUID() }))).json();
    vi.mocked(publishTradingEvent).mockClear();
    const { PATCH } = await import("@/app/api/trade/positions/[id]/route");
    const res = await PATCH(req(`/api/trade/positions/${opened.position.id}`, "PATCH", { slPrice: "4400.00", tpPrice: "4500.00" }), { params: Promise.resolve({ id: opened.position.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toMatch(/^app;dur=\d+$/);
    const body = await res.json();
    expect(body).toMatchObject({ id: opened.position.id, symbol: { name: fx.symbolName } });
    expect(Number(body.slPrice)).toBe(4400);
    expect(Number(body.tpPrice)).toBe(4500);
    const ev = eventOf("PositionModified")!;
    expect(Number((ev.position as { tpPrice: string }).tpPrice)).toBe(4500);
  });

  it("partial then full close: post-close row + balance in body and PositionClosed", async () => {
    if (!dbReachable) return;
    const fx = await fixture(0);
    const orders = await import("@/app/api/trade/orders/route");
    const opened = await (await orders.POST(req("/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.2", price: "4456.53", idempotencyKey: randomUUID() }))).json();
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const id = opened.position.id as string;

    vi.mocked(publishTradingEvent).mockClear();
    calls.length = 0;
    let res = await POST(req(`/api/trade/positions/${id}/close`, "POST", { closePrice: "4456.35", volume: "0.1" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toMatch(/^app;dur=\d+$/);
    let body = await res.json();
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
    expect(body).toMatchObject({ partial: true, balance: acc.balance.toString(), position: { id, status: "OPEN", symbol: { name: fx.symbolName } } });
    expect(Number(body.position.volume)).toBeCloseTo(0.1, 9);
    let ev = eventOf("PositionClosed")!;
    expect(ev).toMatchObject({ partial: true, close_volume: "0.1", balance: acc.balance.toString() });
    expect(calls.indexOf("publish:PositionClosed")).toBeLessThan(calls.indexOf("dealerActivity"));

    vi.mocked(publishTradingEvent).mockClear();
    res = await POST(req(`/api/trade/positions/${id}/close`, "POST", { closePrice: "4456.35" }), { params: Promise.resolve({ id }) });
    body = await res.json();
    expect(body).toMatchObject({ partial: false, position: { id, status: "CLOSED" } });
    ev = eventOf("PositionClosed")!;
    expect((ev.position as { status: string }).status).toBe("CLOSED");
    expect(ev.balance).toBe((await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } })).balance.toString());
  });
});
