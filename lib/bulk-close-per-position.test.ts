import "dotenv/config";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { Prisma, type RoutingCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Bulk close, one transaction per position (owner 2026-11-02, lib/bulk-close.ts). Real commits on this file's own clone
// of the local test DB (vitest.setup.isolated-db.ts), so a close is visible to another connection the moment it commits,
// which is the point being tested. The bridge nudge is recorded together with what another connection could see at that
// moment.
const nudges: { brokerId: string; intentsVisible: number }[] = [];
vi.mock("@/lib/nats", () => ({
  publishTradingEvent: vi.fn().mockResolvedValue(undefined),
  publishBridgeNudge: vi.fn(async (brokerId: string) => {
    // a separate read on the top-level client: only COMMITTED intents are visible here
    nudges.push({ brokerId, intentsVisible: await prisma.hedgeIntent.count({ where: { brokerId } }) });
  }),
}));

const { closeBulkForAccount } = await import("@/lib/bulk-close");

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "seq" FROM "HedgeIntent" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/bulk-close-per-position.test.ts: DB unreachable, skipping");
  }
});
beforeEach(() => {
  nudges.length = 0;
});
afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_bulk_fail ON "Position"`).catch(() => {});
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS zz_bulk_fail()`).catch(() => {});
  await prisma.$disconnect();
});

type Fx = { brokerId: string; accountId: string; symbolId: string; symbolName: string };

async function fixture(category: RoutingCategory): Promise<Fx> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Bulk PP ${suffix}`, subdomain: `bulkpp-${suffix}` } });
  const symbol = await prisma.symbol.create({ data: { name: `BP${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  const alwaysOpen = { create: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, openTime: "00:00", closeTime: "23:59" })) };
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(1000), lotStep: D(0.01), tradingMode: "BOTH", tradingSessions: alwaysOpen } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `BPG-${suffix}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category, dealingMode: "AUTO" } });
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: `3${suffix.slice(0, 7)}`, email: `bulkpp-${suffix}@test.local`, passwordHash: "x", fullName: "Bulk PP", accountMode: "LIVE", leverage: 100, balance: D(1_000_000) },
  });
  return { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, symbolName: symbol.name };
}

/** An open position (groupCategoryAtOpen is stamped by the DB trigger from the account's group). */
async function open(fx: Fx, side: "BUY" | "SELL" = "BUY") {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side, type: "MARKET", volume: D("0.10"), status: "FILLED", filledPrice: D("99.00"), filledAt: new Date(), idempotencyKey: `bp:${randomUUID()}` },
  });
  return prisma.position.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side, volume: D("0.10"), openPrice: D("99.00"), status: "OPEN" } });
}

const refresh = (fx: Fx) => prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { tickAt: new Date() } });

describe("bulk close: one transaction per position", () => {
  it("A-book: every close writes its own hedge intent and wakes the bridge after it COMMITTED, one close at a time", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const positions = [await open(fx), await open(fx), await open(fx), await open(fx, "SELL")];
    await refresh(fx);
    const results = await closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "ALL" });
    expect(results.filter((r) => r.closed)).toHaveLength(4);

    const intents = await prisma.hedgeIntent.findMany({ where: { brokerId: fx.brokerId }, orderBy: { seq: "asc" } });
    expect(intents).toHaveLength(4);
    expect(new Set(intents.map((i) => i.positionId))).toEqual(new Set(positions.map((p) => p.id)));
    expect(intents.every((i) => i.kind === "CLOSE" && i.reason === "BULK")).toBe(true);
    // a close reduces the hedge: the intent's side is the closing deal's side (a BUY closes with a SELL)
    for (const i of intents) expect(i.side).toBe(positions.find((p) => p.id === i.positionId)!.side === "BUY" ? "SELL" : "BUY");
    expect(new Set(intents.map((i) => i.dealId)).size).toBe(4); // one per deal, never two

    // the nudges are not awaited by the loop; let them finish, then: one per close, and the n-th nudge already saw
    // n committed intents (with one shared transaction every nudge would have come after all 4, or seen 0)
    await vi.waitFor(() => expect(nudges).toHaveLength(4));
    expect(nudges.every((n) => n.brokerId === fx.brokerId)).toBe(true);
    for (const n of nudges) expect(n.intentsVisible).toBeGreaterThanOrEqual(1);
    expect(Math.min(...nudges.map((n) => n.intentsVisible))).toBeLessThan(4); // the first nudge went out before the last close
  });

  it("B-book: no hedge intent, no immediate bridge nudge", async () => {
    if (!dbReachable) return;
    const fx = await fixture("B_BOOK");
    await open(fx);
    await open(fx);
    await refresh(fx);
    const results = await closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "ALL" });
    expect(results.filter((r) => r.closed)).toHaveLength(2);
    expect(await prisma.hedgeIntent.count({ where: { brokerId: fx.brokerId } })).toBe(0);
    expect(nudges).toHaveLength(0);
  });

  it("one close fails: only that position rolls back (CLOSE_FAILED, nothing written), the others still close", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const [a, b, c] = [await open(fx), await open(fx), await open(fx)];
    // inject a failure into b's close only: any UPDATE that closes b raises
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION zz_bulk_fail() RETURNS trigger AS $$ BEGIN
      IF NEW.id = '${b.id}' AND NEW.status = 'CLOSED' THEN RAISE EXCEPTION 'injected bulk-close failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER zz_bulk_fail BEFORE UPDATE ON "Position" FOR EACH ROW EXECUTE FUNCTION zz_bulk_fail()`);
    try {
      await refresh(fx);
      const results = await closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "ALL" });
      const by = new Map(results.map((r) => [r.positionId, r]));
      expect(by.get(a.id)).toMatchObject({ closed: true, error: null });
      expect(by.get(b.id)).toMatchObject({ closed: false, error: "CLOSE_FAILED", closePrice: null, realizedPnl: null });
      expect(by.get(c.id)).toMatchObject({ closed: true, error: null });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_bulk_fail ON "Position"`);
    }
    const state = await prisma.position.findMany({ where: { id: { in: [a.id, b.id, c.id] } }, select: { id: true, status: true } });
    expect(Object.fromEntries(state.map((s) => [s.id, s.status]))).toEqual({ [a.id]: "CLOSED", [b.id]: "OPEN", [c.id]: "CLOSED" });
    // b's transaction wrote nothing: no deal, no P/L ledger row, no hedge intent
    expect(await prisma.deal.count({ where: { positionId: b.id, entry: "OUT" } })).toBe(0);
    expect(await prisma.transaction.count({ where: { referenceId: b.id, type: "TRADE_PNL" } })).toBe(0);
    expect(await prisma.hedgeIntent.count({ where: { positionId: b.id, kind: "CLOSE" } })).toBe(0);
    expect(await prisma.hedgeIntent.count({ where: { brokerId: fx.brokerId, kind: "CLOSE" } })).toBe(2);
    // and it can still be closed afterwards, normally
    await refresh(fx);
    const again = await closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "ALL" });
    expect(again).toEqual([expect.objectContaining({ positionId: b.id, closed: true })]);
  });

  it("idempotent: two bulk closes racing over the same positions close each one exactly once", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const positions = await Promise.all(Array.from({ length: 6 }, () => open(fx)));
    await refresh(fx);
    const [r1, r2] = await Promise.all([
      closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "ALL" }),
      closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "ALL" }),
    ]);
    const closedIds = [...r1, ...r2].filter((r) => r.closed).map((r) => r.positionId);
    expect(closedIds.sort()).toEqual(positions.map((p) => p.id).sort()); // each exactly once across both requests
    for (const r of [...r1, ...r2].filter((r) => !r.closed)) expect(r.error).toBe("already closed");
    for (const p of positions) {
      expect(await prisma.deal.count({ where: { positionId: p.id, entry: "OUT" } })).toBe(1);
      expect(await prisma.transaction.count({ where: { referenceId: p.id, type: "TRADE_PNL" } })).toBe(1);
      expect(await prisma.hedgeIntent.count({ where: { positionId: p.id, kind: "CLOSE" } })).toBe(1);
    }
    // a third run finds nothing left to close
    await refresh(fx);
    expect(await closeBulkForAccount(prisma, { accountId: fx.accountId, brokerId: fx.brokerId, scope: "ALL" })).toEqual([]);
  });
});
