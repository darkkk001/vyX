import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// The trader bulk close must honour the client's positionIds (bug 2026-11-09). The route used to drop them, so scope ALL
// closed every open position on the account: a test closed an unlisted XAUUSD 0.30 and realized -116.70 the client
// never asked for. These run the real route against a live DB (same fixture / cleanup discipline as
// app/api/manage/dealing-queue/[id]/queued-close.test.ts) on both paths: direct close (B_BOOK) and dealer queue.
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
    console.warn("close-bulk/route.test.ts: DB unreachable, skipping");
  }
});

type Fixture = { brokerId: string; accountId: string; symbolId: string; symbolName: string };
const createdBrokerIds: string[] = [];

async function createFixture(opts: { dealer: boolean }): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  // desk ON (dealingDeskAutoFillAt null): a DEALING group queues closes, a B_BOOK group closes directly
  const broker = await prisma.broker.create({ data: { name: `Bulk Ids Test ${suffix}`, subdomain: `bitest-${suffix}`, dealingDeskAutoFillAt: null } });
  createdBrokerIds.push(broker.id);
  const symbol = await prisma.symbol.create({ data: { name: `BI${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `TG-${Math.random().toString(36).slice(2, 10)}`, category: opts.dealer ? "DEALING" : "B_BOOK" } });
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: `7${suffix.slice(0, 7)}`, email: `bi-client-${suffix}@test.local`, passwordHash: "x", fullName: "Bulk Ids Client", accountMode: "LIVE", balance: D(10000) },
  });
  return { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function openPosition(fx: Fixture, volume = "1.00", openPrice = "90.00") {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(volume), requestedPrice: D(openPrice), idempotencyKey: `bi-open:${randomUUID()}`, status: "FILLED", filledPrice: D(openPrice), filledAt: new Date() },
  });
  return prisma.position.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side: "BUY", volume: D(volume), openPrice: D(openPrice) },
  });
}

async function refreshPrice(fx: Fixture) {
  await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
}

async function clientBulk(fx: Fixture, body: Record<string, unknown>) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
  const { POST } = await import("./route");
  const request = new NextRequest("https://test.local/api/trade/positions/close-bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await POST(request);
  return { status: response.status, json: await response.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.updateMany({ where, data: { closePendingOrderId: null } });
    await prisma.order.updateMany({ where, data: { closesPositionId: null } });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where }).catch(() => {});
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "BI" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "BI" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("trader bulk close honours positionIds (live DB)", () => {
  it("scope ALL with a subset closes ONLY the listed positions; the unlisted one stays open and the balance moves by the listed P&L only", async () => {
    if (!dbReachable) return;
    const fx = await createFixture({ dealer: false });
    const a = await openPosition(fx);
    const b = await openPosition(fx);
    const unlisted = await openPosition(fx, "0.30", "120.00"); // would realize a loss if closed, like the reported 0.30
    await refreshPrice(fx);

    const { status, json } = await clientBulk(fx, { scope: "ALL", positionIds: [a.id, b.id] });
    expect(status).toBe(200);
    expect(json.requested).toBe(2);
    expect(json.successful).toBe(2);
    expect(json.results.map((r: { positionId: string }) => r.positionId).sort()).toEqual([a.id, b.id].sort());

    const after = await prisma.position.findMany({ where: { accountId: fx.accountId }, select: { id: true, status: true, realizedPnl: true } });
    const byId = new Map(after.map((p) => [p.id, p]));
    expect(byId.get(a.id)!.status).toBe("CLOSED");
    expect(byId.get(b.id)!.status).toBe("CLOSED");
    expect(byId.get(unlisted.id)!.status).toBe("OPEN");
    expect(byId.get(unlisted.id)!.realizedPnl).toBeNull();

    const listedPnl = byId.get(a.id)!.realizedPnl!.add(byId.get(b.id)!.realizedPnl!);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId }, select: { balance: true } });
    expect(account.balance.toFixed(2)).toBe(D(10000).add(listedPnl).toFixed(2));
  });

  it("on a dealer-managed account a subset queues ONLY the listed positions", async () => {
    if (!dbReachable) return;
    const fx = await createFixture({ dealer: true });
    const a = await openPosition(fx);
    const unlisted = await openPosition(fx, "0.30", "120.00");
    await refreshPrice(fx);

    const { status, json } = await clientBulk(fx, { scope: "ALL", positionIds: [a.id] });
    expect(status).toBe(202);
    expect(json.requested).toBe(1);
    expect(json.queued).toBe(1);

    const rows = await prisma.position.findMany({ where: { accountId: fx.accountId }, select: { id: true, status: true, closePendingOrderId: true } });
    const byId = new Map(rows.map((p) => [p.id, p]));
    expect(byId.get(a.id)!.closePendingOrderId).not.toBeNull();
    expect(byId.get(unlisted.id)!.closePendingOrderId).toBeNull();
    expect(byId.get(unlisted.id)!.status).toBe("OPEN");
  });

  it("ids of another account are ignored, never closed", async () => {
    if (!dbReachable) return;
    const mine = await createFixture({ dealer: false });
    const other = await createFixture({ dealer: false });
    const own = await openPosition(mine);
    const foreign = await openPosition(other);
    await refreshPrice(mine);
    await refreshPrice(other);

    const { status, json } = await clientBulk(mine, { scope: "ALL", positionIds: [own.id, foreign.id] });
    expect(status).toBe(200);
    expect(json.requested).toBe(1);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: own.id } })).status).toBe("CLOSED");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe("OPEN");
  });

  it("an empty or malformed positionIds is refused and closes nothing", async () => {
    if (!dbReachable) return;
    const fx = await createFixture({ dealer: false });
    const p = await openPosition(fx);
    await refreshPrice(fx);

    for (const positionIds of [[], "all", [123], [""]]) {
      const { status } = await clientBulk(fx, { scope: "ALL", positionIds });
      expect(status).toBe(400);
    }
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("OPEN");
  });

  it("three positionIds with scope ALL close exactly those three; the other two stay open", async () => {
    if (!dbReachable) return;
    const fx = await createFixture({ dealer: false });
    const listed = [await openPosition(fx), await openPosition(fx, "0.50"), await openPosition(fx, "0.30", "120.00")];
    const unlisted = [await openPosition(fx), await openPosition(fx, "0.20", "110.00")];
    await refreshPrice(fx);

    const { status, json } = await clientBulk(fx, { scope: "ALL", positionIds: listed.map((p) => p.id) });
    expect(status).toBe(200);
    expect(json.requested).toBe(3);
    expect(json.successful).toBe(3);
    const rows = await prisma.position.findMany({ where: { accountId: fx.accountId }, select: { id: true, status: true } });
    const byId = new Map(rows.map((p) => [p.id, p.status]));
    for (const p of listed) expect(byId.get(p.id)).toBe("CLOSED");
    for (const p of unlisted) expect(byId.get(p.id)).toBe("OPEN");
  });

  it("scope PROFIT / LOSS with positionIds close only the listed positions on that side", async () => {
    if (!dbReachable) return;
    // bid 100.00: a BUY opened at 90 is in profit, one opened at 120 / 110 is at a loss
    for (const scope of ["PROFIT", "LOSS"] as const) {
      const fx = await createFixture({ dealer: false });
      const listedWin = await openPosition(fx, "1.00", "90.00");
      const listedLoss = await openPosition(fx, "0.30", "120.00");
      const unlistedWin = await openPosition(fx, "1.00", "95.00");
      const unlistedLoss = await openPosition(fx, "0.20", "110.00");
      await refreshPrice(fx);

      const { status, json } = await clientBulk(fx, { scope, positionIds: [listedWin.id, listedLoss.id] });
      expect(status).toBe(200);
      expect(json.requested).toBe(1);
      expect(json.successful).toBe(1);
      const rows = await prisma.position.findMany({ where: { accountId: fx.accountId }, select: { id: true, status: true } });
      const byId = new Map(rows.map((p) => [p.id, p.status]));
      expect(byId.get(listedWin.id)).toBe(scope === "PROFIT" ? "CLOSED" : "OPEN");
      expect(byId.get(listedLoss.id)).toBe(scope === "LOSS" ? "CLOSED" : "OPEN");
      expect(byId.get(unlistedWin.id)).toBe("OPEN");
      expect(byId.get(unlistedLoss.id)).toBe("OPEN");
    }
  });

  it("without positionIds scope ALL still closes every open position (unchanged)", async () => {
    if (!dbReachable) return;
    const fx = await createFixture({ dealer: false });
    const a = await openPosition(fx);
    const b = await openPosition(fx, "0.30", "120.00");
    await refreshPrice(fx);

    const { status, json } = await clientBulk(fx, { scope: "ALL" });
    expect(status).toBe(200);
    expect(json.successful).toBe(2);
    const rows = await prisma.position.findMany({ where: { id: { in: [a.id, b.id] } }, select: { status: true } });
    expect(rows.every((r) => r.status === "CLOSED")).toBe(true);
  });
});
