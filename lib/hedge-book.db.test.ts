import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Dealing redesign D8 / D10 (owner 2026-10-26) against a real database (skipped when none is reachable). Committed rows,
// cleaned up after: hedgeBySymbol commits its own transactions, like the route.
const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
let brokerId = "";
let symbolName = "";
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; } });
afterAll(async () => {
  if (!dbReachable || !brokerId) return;
  const where = { brokerId };
  await prisma.position.updateMany({ where, data: { coveragePositionId: null } }).catch(() => {});
  for (const m of [prisma.deal, prisma.auditLog, prisma.notification, prisma.transaction] as unknown as { deleteMany: (a: object) => Promise<unknown> }[]) await m.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.broker.update({ where: { id: brokerId }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: symbolName } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: symbolName } }).catch(() => {});
  await prisma.broker.delete({ where: { id: brokerId } }).catch(() => {});
}, 30000);

describe("hedge book per symbol (D8 / D10)", () => {
  it("one leg per side, A-book and demo left out, shared legs shrink by each client's lots and release every client", async () => {
    if (!dbReachable) return;
    const { hedgeBook, hedgeBySymbol } = await import("@/lib/hedge-book");
    const { onClose } = await import("@/lib/coverage");
    const s = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    brokerId = (await prisma.broker.create({ data: { name: `HB ${s}`, subdomain: `hb-${s.toLowerCase()}`, dealingModeAt: null } })).id;
    symbolName = `HB${s}`;
    const sym = await prisma.symbol.create({ data: { name: symbolName, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX" } });
    await prisma.brokerSymbol.create({ data: { brokerId, symbolId: sym.id, tradingMode: "BOTH" } });
    await prisma.livePrice.create({ data: { symbol: symbolName, bid: D("1.10000"), ask: D("1.10020") } });
    const bGroup = await prisma.group.create({ data: { brokerId, name: `B-${s}`, dealingMode: "AUTO", category: "B_BOOK" } });
    const aGroup = await prisma.group.create({ data: { brokerId, name: `A-${s}`, dealingMode: "AUTO", category: "A_BOOK" } });
    const cGroup = await prisma.group.create({ data: { brokerId, name: `Cov-${s}`, category: "COVERAGE", groupType: "COVERAGE", leverage: 500 } });
    const mk = (n: string, groupId: string, mode: "LIVE" | "DEMO" = "LIVE") =>
      prisma.account.create({ data: { brokerId, groupId, accountNumber: `8${s.slice(0, 5)}${n}`, email: `hb-${n}-${s}@t.local`, passwordHash: "x", fullName: `HB ${n}`, accountMode: mode, balance: D(10000) } });
    const c1 = await mk("01", bGroup.id), c2 = await mk("02", bGroup.id), lp = await mk("03", aGroup.id), demo = await mk("04", bGroup.id, "DEMO");
    const cov = await mk("09", cGroup.id);
    await prisma.broker.update({ where: { id: brokerId }, data: { coverageAccountId: cov.id } });
    const open = async (accountId: string, side: "BUY" | "SELL", volume: string, bookType: "A_BOOK" | "B_BOOK" = "B_BOOK") => {
      const o = await prisma.order.create({ data: { brokerId, accountId, symbolId: sym.id, side, type: "MARKET", volume: D(volume), status: "FILLED", filledPrice: D("1.10010"), filledAt: new Date(), idempotencyKey: `hb:${randomUUID()}` } });
      return prisma.position.create({ data: { brokerId, accountId, symbolId: sym.id, originOrderId: o.id, side, volume: D(volume), openPrice: D("1.10010"), bookType } });
    };
    const sells = [];
    for (let i = 0; i < 5; i++) sells.push(await open(i % 2 ? c2.id : c1.id, "SELL", "0.01"));
    const buyA = await open(c1.id, "BUY", "0.10");
    await open(c2.id, "BUY", "0.10");
    const aBook = await open(lp.id, "BUY", "1.00", "A_BOOK"); // A-book group: the liquidity provider's, never the hedge account's
    await open(demo.id, "SELL", "2.00"); // demo: not a live client

    const before = await hedgeBook(brokerId);
    const row = before.symbols.find((r) => r.symbol === symbolName)!;
    expect(row).toMatchObject({ positions: 7, buyLots: "0.20", sellLots: "0.05", netLots: "0.15", hedgedLots: "0.00", unhedgedLots: "0.25", unhedged: { count: 7, buyLots: "0.20", sellLots: "0.05" } });
    expect(row.clientPositions.map((p) => p.positionId)).not.toContain(aBook.id);
    expect(row.hedgeAccount.legs).toEqual([]);

    const done = await hedgeBySymbol(brokerId, null);
    expect(done.map((r) => [r.symbol, r.side, r.clients, r.lots, r.price, r.error])).toEqual([
      [symbolName, "BUY", 2, "0.20", "1.1002", null], // same side as the clients, at the raw market
      [symbolName, "SELL", 5, "0.05", "1.1", null],
    ]);
    expect(await hedgeBySymbol(brokerId, null)).toEqual([]); // nothing left to hedge: never twice
    expect(await prisma.auditLog.count({ where: { brokerId, action: "POSITION_COVERAGE_BOOKED" } })).toBe(7);

    const after = (await hedgeBook(brokerId)).symbols.find((r) => r.symbol === symbolName)!;
    expect(after).toMatchObject({ hedgedLots: "0.25", unhedgedLots: "0.00", hedgeAccount: { buyLots: "0.20", sellLots: "0.05", netLots: "0.15" } });
    expect(after.hedgeAccount.legs.map((l) => [l.side, l.lots, l.clients])).toEqual([["BUY", "0.20", 2], ["SELL", "0.05", 5]]);
    const sellLeg = after.hedgeAccount.legs.find((l) => l.side === "SELL")!;
    const buyLeg = after.hedgeAccount.legs.find((l) => l.side === "BUY")!;

    // a client closes in full: the shared SELL leg shrinks by exactly its 0.01
    await prisma.position.update({ where: { id: sells[0].id }, data: { status: "CLOSED", closedAt: new Date() } });
    await onClose(prisma, { positionId: sells[0].id, brokerId, closedLots: D("0.01"), sourceVolumeBeforeClose: D("0.01"), reason: "manual" });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: sellLeg.positionId } })).volume.toString()).toBe("0.04");
    // a client closes 0.04 of 0.10: the shared BUY leg shrinks by 0.04
    await prisma.position.update({ where: { id: buyA.id }, data: { volume: D("0.06") } });
    await onClose(prisma, { positionId: buyA.id, brokerId, closedLots: D("0.04"), sourceVolumeBeforeClose: D("0.10"), reason: "manual" });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: buyLeg.positionId } })).volume.toString()).toBe("0.16");

    // the shared SELL leg closes: every client still on it is released
    await prisma.position.update({ where: { id: sellLeg.positionId }, data: { status: "CLOSED", closedAt: new Date() } });
    await onClose(prisma, { positionId: sellLeg.positionId, brokerId, closedLots: D("0.04"), sourceVolumeBeforeClose: D("0.04"), reason: "manual" });
    const released = await prisma.position.findMany({ where: { id: { in: sells.slice(1).map((p) => p.id) } }, select: { covered: true, coveragePositionId: true } });
    expect(released).toEqual(Array(4).fill({ covered: false, coveragePositionId: null }));
    expect(await prisma.auditLog.count({ where: { brokerId, action: "POSITION_COVERAGE_RELEASED" } })).toBe(4);
  });
});
