import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computePendingCommission } from "@/lib/commission";

// Deal model step 4, reader ib_lots (lib/deal-reads.ts): PER_LOT IB commission from the client's closes, each at its
// own time. Scratch DB fixtures; the flag is read per call, so each case sets DEAL_READS itself.
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "Deal" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("commission-deals.test.ts: DB unreachable or no Deal table, skipping");
  }
});
const before = process.env.DEAL_READS;
afterEach(() => {
  if (before === undefined) delete process.env.DEAL_READS;
  else process.env.DEAL_READS = before;
});

async function fixture() {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `IB lots ${sfx}`, subdomain: `ibl-${sfx}` } });
  const symbol = await prisma.symbol.create({ data: { name: `IL${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `ILG-${sfx}` } });
  const mk = (n: string) =>
    prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: `${n}${sfx.slice(0, 7)}`, email: `il-${n}-${sfx}@test.local`, passwordHash: "x", fullName: "IB lots", accountMode: "LIVE", balance: D(0), currency: "USD" } });
  const [ib, client] = [await mk("3"), await mk("4")];
  return { brokerId: broker.id, symbolId: symbol.id, ibId: ib.id, clientId: client.id };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

// a BUY of `lots`; closes [lots, at] each with its TRADE_PNL row; `flip` adds a reverse-in-place OUT without one
async function trade(fx: Fx, lots: string, closes: [string, Date][], o: { status: "OPEN" | "CLOSED" | "VOIDED"; flip?: boolean }) {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.clientId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(lots), status: "FILLED", filledPrice: D(100), filledAt: new Date(0), idempotencyKey: `il:${randomUUID()}` },
  });
  const closedLots = closes.reduce((s, [v]) => s.add(D(v)), D(0));
  const last = closes[closes.length - 1]?.[1] ?? null;
  const p = await prisma.position.create({
    data: {
      brokerId: fx.brokerId, accountId: fx.clientId, symbolId: fx.symbolId, originOrderId: order.id, side: "BUY", openPrice: D(100), openedAt: new Date(0),
      volume: o.status === "OPEN" ? D(lots).sub(closedLots) : D(closes[closes.length - 1][0]), closedVolume: closedLots, initialVolume: D(lots),
      status: o.status, closePrice: o.status === "OPEN" ? null : D(101), realizedPnl: closedLots, closedAt: o.status === "OPEN" ? null : last,
    },
  });
  const base = { brokerId: fx.brokerId, accountId: fx.clientId, positionId: p.id, symbolId: fx.symbolId };
  const voidedAt = o.status === "VOIDED" ? new Date() : null;
  if (o.flip) await prisma.deal.create({ data: { ...base, side: "SELL", entry: "OUT", reason: "REVERSE", volume: D(lots), price: D(100), executedAt: new Date(1000), voidedAt } });
  for (const [v, at] of closes) {
    const t = await prisma.transaction.create({
      data: { brokerId: fx.brokerId, accountId: fx.clientId, type: "TRADE_PNL", status: "COMPLETED", amount: D(v), balanceBefore: D(0), balanceAfter: D(v), referenceType: "Position", referenceId: p.id, createdAt: at },
    });
    await prisma.deal.create({ data: { ...base, side: "SELL", entry: "OUT", reason: "CLIENT", volume: D(v), price: D(101), profit: D(v), transactionId: t.id, executedAt: at, voidedAt } });
  }
  return p;
}

describe("IB PER_LOT commission from deals (reader ib_lots)", () => {
  it("counts each close at its own time; flip legs and voided trades never count", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const t0 = new Date("2026-09-01T00:00:00Z");
    const payout = new Date("2026-09-10T00:00:00Z");
    const t1 = new Date("2026-09-15T00:00:00Z");
    const t2 = new Date("2026-09-20T00:00:00Z");
    // 1 lot: 0.40 closed before the payout, 0.60 after it
    await trade(fx, "1.00", [["0.40", t0], ["0.60", t1]], { status: "CLOSED" });
    // still open: 0.30 of 2 lots closed after the payout
    await trade(fx, "2.00", [["0.30", t2]], { status: "OPEN" });
    // reversed in place once, then closed after the payout: only its real close counts
    await trade(fx, "0.50", [["0.50", t2]], { status: "CLOSED", flip: true });
    // voided after the payout: nothing
    await trade(fx, "5.00", [["5.00", t1]], { status: "VOIDED" });
    const rel = { clientAccountId: fx.clientId, ibAccountId: fx.ibId, frozenAt: null, commissionType: "PER_LOT" as const, commissionRate: D(10), lastPayoutAt: payout };

    // positions (flag off): every lot of a position closed after the payout, nothing of the open one
    delete process.env.DEAL_READS;
    expect((await computePendingCommission(prisma, rel)).toString()).toBe("15"); // (1.00 + 0.50) x 10

    // deals: 0.60 + 0.30 + 0.50 closed after the payout
    process.env.DEAL_READS = "history,book_pnl,ib_lots";
    expect((await computePendingCommission(prisma, rel)).toString()).toBe("14");
    // a suspended partner: closes up to the suspension only (0.60 at t1)
    expect((await computePendingCommission(prisma, { ...rel, frozenAt: new Date("2026-09-16T00:00:00Z") })).toString()).toBe("6");
    // never paid: everything (1.00 + 0.30 + 0.50)
    expect((await computePendingCommission(prisma, { ...rel, lastPayoutAt: null })).toString()).toBe("18");
  });

  it("PERCENTAGE is unchanged by the flag", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await trade(fx, "1.00", [["1.00", new Date("2026-09-15T00:00:00Z")]], { status: "CLOSED" });
    await prisma.position.update({ where: { id: p.id }, data: { commission: D(8) } });
    const rel = { clientAccountId: fx.clientId, ibAccountId: fx.ibId, frozenAt: null, commissionType: "PERCENTAGE" as const, commissionRate: D(25), lastPayoutAt: null };
    delete process.env.DEAL_READS;
    const off = (await computePendingCommission(prisma, rel)).toString();
    process.env.DEAL_READS = "all";
    expect((await computePendingCommission(prisma, rel)).toString()).toBe(off);
    expect(off).toBe("2");
  });
});
