import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Server price authority on the client close (2026-09-18). Before this, the
// body's `closePrice` was the fill: anything inside the 2% deviation band was
// accepted as the price the P&L was computed from, side ignored, so a client
// could close a BUY 1.9% above the market and pocket the difference. These
// run the real route against a live DB (same fixture discipline as
// app/api/manage/dealing-queue/[id]/queued-close.test.ts) and assert, with
// money, that the fill is closePriceFor(side, bid, ask) and nothing else.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("close/route.test.ts: DB unreachable, skipping");
  }
});

type Fixture = { brokerId: string; accountId: string; symbolId: string; symbolName: string };
const createdBrokerIds: string[] = [];
const createdSymbolNames: string[] = [];

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  // dealingModeAt null = no dealer queue: the route executes the close itself.
  const broker = await prisma.broker.create({ data: { name: `Close Price Test ${suffix}`, subdomain: `cptest-${suffix}`, dealingModeAt: null } });
  createdBrokerIds.push(broker.id);
  const symbol = await prisma.symbol.create({ data: { name: `CP${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  createdSymbolNames.push(symbol.name);
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const _g0 = await prisma.group.create({ data: { brokerId: broker.id, name: `TG-${Math.random().toString(36).slice(2, 10)}`, dealingMode: "AUTO" } });
  const account = await prisma.account.create({
    data: { groupId: _g0.id, brokerId: broker.id, accountNumber: `7${suffix.slice(0, 7)}`, email: `cp-client-${suffix}@test.local`, passwordHash: "x", fullName: "Close Price Client", accountMode: "LIVE", balance: D(10000) },
  });
  return { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function openPosition(fx: Fixture, side: "BUY" | "SELL", openPrice: string) {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side, type: "MARKET", volume: D("1.00"), requestedPrice: D(openPrice), idempotencyKey: `cp-open:${randomUUID()}`, status: "FILLED", filledPrice: D(openPrice), filledAt: new Date() },
  });
  return prisma.position.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side, volume: D("1.00"), openPrice: D(openPrice) },
  });
}

async function refreshPrice(fx: Fixture, bid = "100.00", ask = "100.10") {
  await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D(bid), ask: D(ask), tickAt: new Date() } });
}

async function clientClose(fx: Fixture, positionId: string, body: Record<string, unknown>) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
  const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
  const request = new NextRequest(`https://test.local/api/trade/positions/${positionId}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await POST(request, { params: Promise.resolve({ id: positionId }) });
  return { status: response.status, json: await response.json() };
}

async function balance(fx: Fixture) {
  return (await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId }, select: { balance: true } })).balance;
}

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where: { brokerId: { in: createdBrokerIds } } }).catch(() => {});
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: createdSymbolNames } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: createdSymbolNames } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("client close is priced by the server, never by the client", () => {
  it("the money-mint exploit: a BUY closed at a client price 1.9% above market is rejected, nothing moves", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, "BUY", "90.00");
    await refreshPrice(fx); // bid 100.00 / ask 100.10, mid 100.05
    const before = await balance(fx);
    // 101.90 is 1.85% off mid -- inside evaluateLiveMarketPrice's 2% band, so
    // the old route would have filled at it and credited (101.90 - 90) = 11.90
    // instead of the real (100.00 - 90) = 10.00.
    const res = await clientClose(fx, pos.id, { closePrice: "101.90", maxSlippagePips: "5" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("SLIPPAGE_EXCEEDED");
    expect(res.json.serverPrice).toBe("100");
    const after = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(after.status).toBe("OPEN");
    expect((await balance(fx)).equals(before)).toBe(true);
  });

  it("a BUY fills at the bid and the P&L is computed from it", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, "BUY", "90.00");
    await refreshPrice(fx);
    const before = await balance(fx);
    const res = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(res.status).toBe(200);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(after.status).toBe("CLOSED");
    expect(after.closePrice!.toString()).toBe("100");
    expect(after.realizedPnl!.toString()).toBe("10");
    expect((await balance(fx)).sub(before).toString()).toBe("10");
  });

  it("a SELL fills at the ASK even when the client sends the bid -- side is the server's call", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, "SELL", "110.00");
    await refreshPrice(fx); // ask 100.10
    // Client sends 100.00 (the bid). Old route: filled at 100.00, P&L 10.00.
    // Server: a SELL is bought back at ask 100.10, P&L 9.90. Within the 5-pip
    // default tolerance (digits 2 -> pip 0.1 -> 0.5), so it fills -- at ask.
    const res = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(res.status).toBe(200);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(after.closePrice!.toString()).toBe("100.1");
    expect(after.realizedPnl!.toString()).toBe("9.9");
  });

  it("no slippage preference (unlimited since 2026-09-24) fills at the server price, not the client's", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, "BUY", "90.00");
    await refreshPrice(fx);
    const res = await clientClose(fx, pos.id, { closePrice: "101.90" });
    expect(res.status).toBe(200);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(after.closePrice!.toString()).toBe("100");
    expect(after.realizedPnl!.toString()).toBe("10");
  });

  it("an 'unlimited' slippage opt-out still fills at the server price, not the client's", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, "BUY", "90.00");
    await refreshPrice(fx);
    const res = await clientClose(fx, pos.id, { closePrice: "101.90", maxSlippagePips: "unlimited" });
    expect(res.status).toBe(200);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(after.closePrice!.toString()).toBe("100");
    expect(after.realizedPnl!.toString()).toBe("10");
  });

  it("a stale feed refuses the close instead of filling at whatever the client says", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, "BUY", "90.00");
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { tickAt: new Date(Date.now() - 60_000) } });
    const res = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("NO_LIVE_FEED");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe("OPEN");
  });

  // 2026-09-25: the schedule says open but THIS market has not ticked (reopen after a break, holiday) while the feed is
  // alive (another enabled symbol ticks): that is a closed market to the trader, not a "feed gap".
  it("no tick on this symbol while another ticks = MARKET_CLOSED (not quoting), nothing moves", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const pos = await openPosition(fx, "BUY", "90.00");
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { tickAt: new Date(Date.now() - 62 * 60_000) } });
    const other = await prisma.symbol.create({ data: { name: `${fx.symbolName}B`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
    createdSymbolNames.push(other.name);
    await prisma.brokerSymbol.create({ data: { brokerId: fx.brokerId, symbolId: other.id, tradingMode: "BOTH" } });
    await prisma.livePrice.create({ data: { symbol: other.name, bid: D("50.00"), ask: D("50.10"), tickAt: new Date() } });
    const before = await balance(fx);
    const res = await clientClose(fx, pos.id, { closePrice: "100.00" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("MARKET_CLOSED");
    expect(res.json.reason).toBe("NOT_QUOTING");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe("OPEN");
    expect((await balance(fx)).equals(before)).toBe(true);
  });
});
