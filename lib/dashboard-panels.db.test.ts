import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// bo 1.0.96 panels against a real database (skipped when none is reachable). Seeds one broker: two live clients with
// closes / commission / swap, a voided trade (left out), a demo account (left out under live), and 1-lot+ opens.
vi.mock("@/lib/live-price", () => ({ getFreshPrices: vi.fn(async () => new Map()) }));
vi.mock("@/lib/bridge-status", () => ({ bridgeStatus: vi.fn(async () => ({ badge: "CONNECTED", text: "Connected", since: null, lastReportAt: null })) }));
vi.mock("@/lib/market-data-client", () => ({ readVpsPrices: vi.fn(async () => ({ ok: false, reason: "test" })) }));

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
let brokerId = "";
const symbolIds: string[] = [];
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; } });
afterAll(async () => {
  if (!dbReachable || !brokerId) return;
  const where = { brokerId };
  await prisma.deal.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { id: { in: symbolIds } } }).catch(() => {});
  await prisma.broker.delete({ where: { id: brokerId } }).catch(() => {});
}, 30000);

describe("dashboard panels (db)", () => {
  it("winners / losers, big trades, net exposure, balance-after", async () => {
    if (!dbReachable) return;
    const { topAccounts, bigTrades, netExposure, largePositions } = await import("@/lib/dashboard-panels");
    const { bookedBalanceAfter } = await import("@/lib/balance-after");
    const s = randomUUID().replace(/-/g, "").slice(0, 8);
    brokerId = (await prisma.broker.create({ data: { name: `DP ${s}`, subdomain: `dp-${s}`, dealingModeAt: null } })).id;
    const group = await prisma.group.create({ data: { brokerId, name: `G-${s}`, dealingMode: "AUTO" } });
    const sym = await prisma.symbol.create({ data: { name: `X${s}`.toUpperCase(), baseCurrency: "XAU", quoteCurrency: "USD", category: "METALS", contractSize: D(100) } });
    symbolIds.push(sym.id);
    const mk = (n: string, mode: "LIVE" | "DEMO" = "LIVE") =>
      prisma.account.create({ data: { brokerId, groupId: group.id, accountNumber: `7${s.slice(0, 6)}${n}`, email: `dp-${n}-${s}@t.local`, passwordHash: "x", fullName: `DP ${n}`, accountMode: mode, balance: D("1000") } });
    const win = await mk("1"), lose = await mk("2"), demo = await mk("3", "DEMO");
    let ticket = Math.floor(Math.random() * 1e8);
    const now = Date.now();
    const pos = async (accountId: string, side: "BUY" | "SELL", volume: string, opts: { status?: "OPEN" | "CLOSED" | "VOIDED"; profit?: string; commission?: string; voided?: boolean } = {}) => {
      const order = await prisma.order.create({ data: { brokerId, accountId, symbolId: sym.id, side, type: "MARKET", volume: D(volume), idempotencyKey: randomUUID() } });
      const p = await prisma.position.create({ data: { brokerId, accountId, symbolId: sym.id, originOrderId: order.id, ticket: ++ticket, side, volume: D(volume), openPrice: D("4000"), status: opts.status ?? "OPEN" } });
      const voidedAt = opts.voided ? new Date() : null;
      await prisma.deal.create({ data: { brokerId, accountId, positionId: p.id, symbolId: sym.id, side, entry: "IN", reason: "CLIENT", volume: D(volume), price: D("4000"), commission: D(opts.commission ?? "0"), executedAt: new Date(now - 3600_000), voidedAt } });
      if (opts.profit) await prisma.deal.create({ data: { brokerId, accountId, positionId: p.id, symbolId: sym.id, side: side === "BUY" ? "SELL" : "BUY", entry: "OUT", reason: "CLIENT", volume: D(volume), price: D("4010"), profit: D(opts.profit), transactionId: null, executedAt: new Date(now - 1800_000), voidedAt } });
      return p;
    };
    await pos(win.id, "BUY", "1.50", { status: "CLOSED", profit: "300", commission: "-7" });
    await pos(lose.id, "SELL", "0.50", { status: "CLOSED", profit: "-120", commission: "-3" });
    await pos(lose.id, "BUY", "5.00", { status: "VOIDED", profit: "900", voided: true }); // voided: in no panel
    await pos(win.id, "BUY", "2.00"); // open
    await pos(lose.id, "SELL", "0.50"); // open
    await pos(demo.id, "BUY", "3.00"); // demo: not a live client
    const swap = await prisma.transaction.create({ data: { brokerId, accountId: lose.id, type: "SWAP", status: "COMPLETED", amount: D("-4"), balanceBefore: D(0), balanceAfter: D(0) } });

    const who = Prisma.sql`a."brokerId" = ${brokerId} AND a."accountMode" = 'LIVE' AND a."isInternal" = false`;
    const from = new Date(now - 7 * 86_400_000);
    const [ccy] = await topAccounts(brokerId, who, from);
    expect(ccy.currency).toBe("USD");
    expect(ccy.winners.map((r) => [r.accountNumber, r.netPnl, r.grossPnl, r.commission, r.swap])).toEqual([[win.accountNumber, "293.00", "300.00", "7.00", "0.00"]]);
    expect(ccy.losers.map((r) => [r.accountNumber, r.netPnl, r.grossPnl, r.commission, r.swap])).toEqual([[lose.accountNumber, "-127.00", "-120.00", "3.00", "4.00"]]);

    const big = await bigTrades(brokerId, who, { key: "7D", from, to: null });
    expect(big.map((r) => [r.accountNumber, r.side, r.lots]).sort()).toEqual([[win.accountNumber, "BUY", "1.50"], [win.accountNumber, "BUY", "2.00"]]); // the 5-lot voided and the 3-lot demo trade are not listed

    const exp = await netExposure(brokerId, Prisma.sql`${who} AND TRUE`);
    // open: 2.00 BUY (win) + 0.50 SELL (lose); demo left out; no fresh price in this test -> notional null
    expect(exp).toEqual([{ symbol: sym.name, buyLots: "2.00", sellLots: "0.50", netLots: "1.50", positions: 2, notionalUsd: null }]);

    // LARGE POSITION: book 2.50 open lots; win holds 2.00 (80%, >= 1 lot) = flagged; lose 0.50 (20%) = not
    const large = await largePositions(brokerId, who);
    expect(large).toMatchObject({ rule: { minSharePct: 25, minLots: "1.00" }, bookLots: "2.50", count: 1 });
    expect(large.rows.map((r) => [r.kind, r.accountNumber, r.lots, r.sharePct, r.positions])).toEqual([["LARGE_POSITION", win.accountNumber, "2.00", "80", 1]]);
    // the old bug: a small account alone on the book is 100% of it but under 1 lot -> never flagged
    const alone = await largePositions(brokerId, Prisma.sql`${who} AND a.id = ${lose.id}`);
    expect(alone).toMatchObject({ bookLots: "0.50", count: 0, rows: [] });

    const ba = await bookedBalanceAfter([swap.id]);
    expect(ba.get(swap.id)).toBe("1000.00"); // the last row: balance after it = the balance now
  });
});
