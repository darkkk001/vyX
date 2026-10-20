import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, RoutingCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Book P/L from the Deal table (deal model step 4, DEAL_READS=book_pnl): every close counts on its own execution time,
// with the deal profit (= the TRADE_PNL amount). Closes are made with the REAL close code (closePositionInTx), which writes
// the deals; the same exclusions as the ledger way (lib/book-pnl.ts heldSql). Real fixtures on the scratch DB.
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
import { bookPnlRealizedFromDeals, bookPnlRealizedFromPositions } from "@/lib/book-pnl";

const D = (v: string | number) => new Prisma.Decimal(v);
const HOUR = 3600_000;

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("book-pnl-deals.test.ts: DB unreachable, skipping");
  }
});
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.deal.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { account: { brokerId: { in: brokers } } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

type Fx = { brokerId: string; symbolId: string; groups: Record<RoutingCategory, string> };
async function fixture(): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `BookPnlDeals ${sfx}`, subdomain: `bpd-${sfx}` } });
  brokers.push(b.id);
  const name = `BD${sfx.toUpperCase()}`;
  symbols.push(name);
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("110.00"), ask: D("110.10"), tickAt: new Date() } });
  const groups = {} as Record<RoutingCategory, string>;
  for (const c of ["A_BOOK", "B_BOOK", "DEALING", "REVERSAL", "COVERAGE"] as RoutingCategory[]) {
    groups[c] = (await prisma.group.create({ data: { brokerId: b.id, name: `${c}-${sfx}`, category: c } })).id;
  }
  return { brokerId: b.id, symbolId: s.id, groups };
}
async function account(fx: Fx, category: RoutingCategory, opts?: { mode?: "LIVE" | "DEMO"; internal?: boolean; currency?: string }) {
  const n = `5${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "4")}`;
  return prisma.account.create({
    data: {
      groupId: fx.groups[category], brokerId: fx.brokerId, accountNumber: n, email: `bd-${n}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", fullName: `BD ${n}`,
      accountMode: opts?.mode ?? "LIVE", isInternal: opts?.internal ?? false, currency: opts?.currency ?? "USD", balance: D(100000), leverage: 100,
    },
  });
}
async function open(fx: Fx, accountId: string, volume = "1") {
  const o = await prisma.order.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(volume), requestedPrice: D(100), idempotencyKey: `bd:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
  return prisma.position.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: o.id, side: "BUY", volume: D(volume), openPrice: D(100), bookType: "B_BOOK" } });
}
/** Real close (writes TRADE_PNL + its deal), then both stamped at `when`. A BUY of 1 lot opened at 100: P/L = (price - 100) x lots. */
async function close(positionId: string, price: string, lots: string | undefined, when: Date) {
  const { closePositionInTx } = await import("@/lib/position-close");
  await prisma.$transaction(async (tx) => {
    const p = await tx.position.findUniqueOrThrow({ where: { id: positionId }, include: { symbol: true } });
    const r = await closePositionInTx(tx, { deal: { reason: "CLIENT" }, position: p, closePrice: price, closeVolume: lots ? D(lots) : undefined });
    expect(r.closed).toBe(true);
  });
  const last = await prisma.transaction.findFirstOrThrow({ where: { referenceId: positionId, type: "TRADE_PNL" }, orderBy: { createdAt: "desc" } });
  await prisma.transaction.update({ where: { id: last.id }, data: { createdAt: when } });
  await prisma.deal.updateMany({ where: { transactionId: last.id }, data: { executedAt: when } });
  const p = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
  if (p.status === "CLOSED") await prisma.position.update({ where: { id: positionId }, data: { closedAt: when } });
}
const scope = (fx: Fx) => ({ brokerId: fx.brokerId, coverageAccountId: null });
const json = (rows: { currency: string; amount: Prisma.Decimal; count: number }[]) => rows.map((r) => ({ currency: r.currency, amount: r.amount.toFixed(2), count: r.count }));

describe("bookPnlRealizedFromDeals", () => {
  it("equals the ledger way for single full closes, with the same exclusions", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const now = new Date();
    const counted = [await account(fx, "B_BOOK"), await account(fx, "DEALING")];
    const excluded = [
      await account(fx, "A_BOOK"), await account(fx, "REVERSAL"), await account(fx, "COVERAGE"),
      await account(fx, "B_BOOK", { mode: "DEMO" }), await account(fx, "B_BOOK", { internal: true }),
    ];
    for (const a of [...counted, ...excluded]) await close((await open(fx, a.id)).id, "103", undefined, now);
    const since = new Date(now.getTime() - HOUR);
    const viaDeals = json(await bookPnlRealizedFromDeals(prisma, scope(fx), since));
    expect(viaDeals).toEqual([{ currency: "USD", amount: "-6.00", count: 2 }]);
    expect(viaDeals).toEqual(json(await bookPnlRealizedFromPositions(prisma, scope(fx), since)));
  });

  it("a partial close of a still open position counts on its own day; the ledger way waits for the final close", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await account(fx, "B_BOOK");
    const p = await open(fx, a.id, "1");
    const yesterday = new Date(Date.now() - 24 * HOUR);
    await close(p.id, "104", "0.5", yesterday); // client +2.00 yesterday
    const today = new Date();
    const dayStart = new Date(today.getTime() - 2 * HOUR);
    expect(json(await bookPnlRealizedFromDeals(prisma, scope(fx), new Date(yesterday.getTime() - HOUR), dayStart))).toEqual([{ currency: "USD", amount: "-2.00", count: 1 }]);
    expect(await bookPnlRealizedFromPositions(prisma, scope(fx), new Date(yesterday.getTime() - HOUR), dayStart)).toEqual([]);
    await close(p.id, "106", undefined, today); // client +3.00 today
    expect(json(await bookPnlRealizedFromDeals(prisma, scope(fx), dayStart))).toEqual([{ currency: "USD", amount: "-3.00", count: 1 }]);
  });

  it("a position closed in several parts counts every part (the ledger way counted only Position.realizedPnl)", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await account(fx, "B_BOOK");
    const p = await open(fx, a.id, "1");
    const now = new Date();
    await close(p.id, "102", "0.4", now); // +0.80
    await close(p.id, "105", undefined, now); // +3.00
    const since = new Date(now.getTime() - HOUR);
    expect(json(await bookPnlRealizedFromDeals(prisma, scope(fx), since))).toEqual([{ currency: "USD", amount: "-3.80", count: 1 }]);
    const ledger = await prisma.transaction.aggregate({ where: { referenceId: p.id, type: "TRADE_PNL" }, _sum: { amount: true } });
    expect(ledger._sum.amount!.toFixed(2)).toBe("3.80");
  });

  it("voided deals and deleted positions are left out", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await account(fx, "B_BOOK");
    const now = new Date();
    const voided = await open(fx, a.id);
    await close(voided.id, "110", undefined, now);
    await prisma.deal.updateMany({ where: { positionId: voided.id }, data: { voidedAt: now } });
    const deleted = await open(fx, a.id);
    await close(deleted.id, "110", undefined, now);
    await prisma.position.update({ where: { id: deleted.id }, data: { deletedAt: now } });
    expect(await bookPnlRealizedFromDeals(prisma, scope(fx), new Date(now.getTime() - HOUR))).toEqual([]);
  });
});
