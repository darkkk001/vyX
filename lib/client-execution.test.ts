import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clientExecution } from "@/lib/order-execution";
import { loadDealExecutions, loadPositionExecutions } from "@/lib/client-execution";

// D-4 (owner 2026-10-23): the client's execution subset on /api/trade/history and /api/trade/deals.

const D = (v: string | number) => new Prisma.Decimal(v);

describe("clientExecution", () => {
  const detail = { orderTicket: 7, orderType: "MARKET", status: "FILLED", source: "WEB", requestedAt: "a", executedAt: "b", latencyMs: 41, requestedPrice: "4029.75", filledPrice: "4029.76", clientIp: "203.0.113.9", platform: "Windows", routing: "B_BOOK", executionMode: "AUTO" };
  it("never carries the broker's book or desk mode", () => {
    const c = clientExecution(detail);
    expect(c).not.toHaveProperty("routing");
    expect(c).not.toHaveProperty("executionMode");
    expect(c).toMatchObject({ orderTicket: 7, requestedPrice: "4029.75", filledPrice: "4029.76", latencyMs: 41, platform: "Windows" });
  });
  it("keeps the IP of a leg the client placed, drops a staff member's", () => {
    expect(clientExecution(detail).clientIp).toBe("203.0.113.9");
    expect(clientExecution({ ...detail, source: "ADMIN", clientIp: "10.0.0.5" })).not.toHaveProperty("clientIp");
    expect(clientExecution({ ...detail, source: undefined as unknown as string })).not.toHaveProperty("clientIp");
  });
});

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "routing", "executionMode", "clientIp" FROM "Order" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/client-execution.test.ts: DB (with the execution columns) unreachable, skipping");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});

class RollbackSignal extends Error {}
async function withRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
}

describe("loadPositionExecutions / loadDealExecutions (live DB, rolled back)", () => {
  it("open from the client's order; close from the queued close order or, without one, the OUT deal; subset only", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
      const broker = await tx.broker.create({ data: { name: `Exec ${sfx}`, subdomain: `exec-${sfx}` } });
      const group = await tx.group.create({ data: { brokerId: broker.id, name: `EX-${sfx}` } });
      const account = await tx.account.create({ data: { brokerId: broker.id, groupId: group.id, accountNumber: `7${sfx.slice(0, 7)}`, email: `exec-${sfx}@test.local`, passwordHash: "x", fullName: "Exec", accountMode: "LIVE", balance: D(1000) } });
      const symbol = await tx.symbol.create({ data: { name: `EX${sfx}`.slice(0, 12).toUpperCase(), baseCurrency: "XAU", quoteCurrency: "USD", category: "METALS" } });
      const t0 = new Date("2026-10-22T22:19:47.952Z"), t1 = new Date("2026-10-22T22:19:48.011Z");
      const mkOrder = (source: "WEB" | "ADMIN", extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
        tx.order.create({ data: { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, side: "BUY", type: "MARKET", volume: D("0.01"), status: "FILLED", filledPrice: D("4029.76"), filledAt: t1, requestedPrice: D("4029.75"), requestedAt: t0, executedAt: t1, clientIp: source === "WEB" ? "203.0.113.9" : "10.0.0.5", platform: "Windows", routing: "B_BOOK", executionMode: "AUTO", source, idempotencyKey: `exec:${randomUUID()}`, ...extra } });
      const mkPos = async (status: "CLOSED") => {
        const o = await mkOrder("WEB");
        return tx.position.create({ data: { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, originOrderId: o.id, side: "BUY", volume: D("0.01"), openPrice: D("4029.76"), status, closePrice: D("4029.01"), closedAt: t1 } });
      };
      const a = await mkPos("CLOSED"); // closed by a staff member through a queued close order
      await mkOrder("ADMIN", { closesPositionId: a.id, side: "SELL", filledPrice: D("4029.01") });
      const b = await mkPos("CLOSED"); // closed directly by the client: an OUT deal, no order
      const outDeal = await tx.deal.create({ data: { brokerId: broker.id, accountId: account.id, positionId: b.id, symbolId: symbol.id, side: "SELL", entry: "OUT", reason: "CLIENT", source: "WEB", volume: D("0.01"), price: D("4029.01"), profit: D("-0.75"), executedAt: t1, requestedAt: t0, requestedPrice: D("4029.04"), clientIp: "203.0.113.9", platform: "Windows", routing: "B_BOOK", executionMode: "AUTO" } });

      const ex = await withClient(tx, () => loadPositionExecutions(account.id, [a, b].map((p) => ({ ...p, symbol: { digits: 2 } }))));
      const ea = ex.get(a.id)!, eb = ex.get(b.id)!;
      for (const e of [ea.openExecution, ea.closeExecution, eb.openExecution, eb.closeExecution]) {
        expect(e).toBeDefined();
        expect(e).not.toHaveProperty("routing");
        expect(e).not.toHaveProperty("executionMode");
      }
      expect(ea.openExecution).toMatchObject({ requestedPrice: "4029.75", filledPrice: "4029.76", latencyMs: 59, clientIp: "203.0.113.9", source: "WEB" });
      expect(ea.closeExecution).toMatchObject({ source: "ADMIN", filledPrice: "4029.01" });
      expect(ea.closeExecution).not.toHaveProperty("clientIp"); // the staff member's IP never reaches the client
      expect(eb.closeExecution).toMatchObject({ dealTicket: Number(outDeal.ticket), requestedPrice: "4029.04", filledPrice: "4029.01", clientIp: "203.0.113.9", latencyMs: 59 });

      const deals = await tx.deal.findMany({ where: { accountId: account.id } });
      const dealEx = await withClient(tx, () => loadDealExecutions(account.id, deals, () => 2, () => "B_BOOK"));
      const e = dealEx(deals.find((d) => d.id === outDeal.id)!)!;
      expect(e).toMatchObject({ filledPrice: "4029.01", clientIp: "203.0.113.9" });
      expect(e).not.toHaveProperty("routing");
    });
  });
});

// The loaders use the shared prisma client; inside the rolled-back transaction they must read through `tx`. Swap the
// client's model accessors for the transaction's for the duration of `fn`.
async function withClient<T>(tx: Prisma.TransactionClient, fn: () => Promise<T>): Promise<T> {
  const p = prisma as unknown as Record<string, unknown>;
  const t = tx as unknown as Record<string, unknown>;
  const saved = { order: p.order, deal: p.deal };
  p.order = t.order;
  p.deal = t.deal;
  try {
    return await fn();
  } finally {
    p.order = saved.order;
    p.deal = saved.deal;
  }
}
