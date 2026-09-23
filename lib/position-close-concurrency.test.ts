import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { closePositionInTx } from "@/lib/position-close";

// Lost update on Account.balance (2026-09-23). closePositionInTx read the balance with a plain SELECT and
// wrote back balance + P&L. Two closes of DIFFERENT positions on the same account at the same moment (the
// risk monitor's stop-out and the trader's own close, two SL/TPs, a bulk close racing a dealer) both read
// the same starting balance and the second write erased the first close's P&L, while both TRADE_PNL rows
// were written. The balance row is now locked (SELECT ... FOR UPDATE) before it is read.
//
// Real concurrent transactions need committed rows, so the fixture is committed and removed afterwards.

const D = (v: string | number) => new Prisma.Decimal(v);
const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
const N = 10;
let dbReachable = false;
const ids = { broker: "", group: "", account: "", symbol: "", positions: [] as string[] };

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    return;
  }
  const broker = await prisma.broker.create({ data: { name: `Close Concurrency ${suffix}`, subdomain: `ccy-${suffix}` } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `CCY-${suffix}`, dealingMode: "AUTO" } });
  const account = await prisma.account.create({
    data: { brokerId: broker.id, groupId: group.id, accountNumber: `6${suffix.slice(0, 7)}`, email: `ccy-${suffix}@test.local`, passwordHash: "x", fullName: "Close Concurrency", accountMode: "LIVE", balance: D("100000") },
  });
  const symbol = await prisma.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
  Object.assign(ids, { broker: broker.id, group: group.id, account: account.id, symbol: symbol.id });
  for (let i = 0; i < N; i++) {
    const order = await prisma.order.create({ data: { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, side: "BUY", type: "MARKET", volume: D("1"), status: "FILLED", filledPrice: D("4000"), filledAt: new Date(), idempotencyKey: `ccy:${randomUUID()}` } });
    const pos = await prisma.position.create({ data: { brokerId: broker.id, accountId: account.id, symbolId: symbol.id, originOrderId: order.id, side: "BUY", volume: D("1"), openPrice: D("4000"), status: "OPEN" } });
    ids.positions.push(pos.id);
  }
});

afterAll(async () => {
  if (dbReachable && ids.broker) {
    await prisma.transaction.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.auditLog.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.position.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.order.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.account.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.group.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.broker.delete({ where: { id: ids.broker } });
  }
  await prisma.$disconnect();
});

describe("closePositionInTx under real concurrency", () => {
  it(`${N} different positions of one account closed at the same moment: every P&L reaches the balance`, async () => {
    if (!dbReachable) return;
    // each closes +10 x 100 x 1 = +1,000
    await Promise.all(
      ids.positions.map((id) =>
        prisma.$transaction((tx) =>
          closePositionInTx(tx, {
            position: { id, accountId: ids.account, brokerId: ids.broker, side: "BUY", openPrice: D("4000"), volume: D("1"), symbol: { contractSize: D("100") } },
            closePrice: "4010",
          })
        )
      )
    );
    const acct = await prisma.account.findUniqueOrThrow({ where: { id: ids.account } });
    expect(await prisma.transaction.count({ where: { accountId: ids.account, type: "TRADE_PNL" } })).toBe(N);
    expect(acct.balance.toString()).toBe(String(100000 + N * 1000));
  });
});
