import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Deal model step 4, reader reports_trading (lib/deal-reads.ts): the Reports trading CSV, one row per close.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
import { GET } from "./route";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "Deal" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("reports/trading route.test.ts: DB unreachable or no Deal table, skipping");
  }
});
const before = process.env.DEAL_READS;
afterEach(() => {
  if (before === undefined) delete process.env.DEAL_READS;
  else process.env.DEAL_READS = before;
});

async function fixture() {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `RT ${sfx}`, subdomain: `rt-${sfx}` } });
  const symbol = await prisma.symbol.create({ data: { name: `RT${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `RTG-${sfx}` } });
  const mk = (n: string, accountMode: "LIVE" | "DEMO") =>
    prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: `${n}${sfx.slice(0, 7)}`, email: `rt-${n}-${sfx}@test.local`, passwordHash: "x", fullName: "RT", accountMode, balance: D(0), currency: "USD" } });
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `rt-${sfx}@test.local`, passwordHash: "x", role: "MANAGER" } });
  return { brokerId: broker.id, symbolId: symbol.id, live: (await mk("5", "LIVE")).id, demo: (await mk("6", "DEMO")).id, adminId: admin.id };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

// a BUY of `lots` at 100 opened `opened` days ago (IN deal with its Order, commission 0.50 charged); closes
// [lots, price, profit, when] each with its TRADE_PNL row; `flip` adds a reverse-in-place OUT + IN pair (no Order, no row)
async function trade(fx: Fx, accountId: string, lots: string, closes: [string, string, string, Date][], o: { status: "OPEN" | "CLOSED" | "VOIDED"; flip?: boolean; opened?: number }) {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(lots), status: "FILLED", filledPrice: D(100), filledAt: ago(40), idempotencyKey: `rt:${randomUUID()}` },
  });
  const closed = closes.reduce((s, [v]) => s.add(D(v)), D(0));
  const p = await prisma.position.create({
    data: {
      brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: order.id, side: "BUY", openPrice: D(100), openedAt: ago(40),
      volume: o.status === "OPEN" ? D(lots).sub(closed) : D(closes[closes.length - 1][0]), closedVolume: closed, initialVolume: D(lots), status: o.status,
      closePrice: o.status === "OPEN" ? null : D(closes[closes.length - 1][1]), realizedPnl: D(closes[closes.length - 1][2]),
      closedAt: o.status === "OPEN" ? null : closes[closes.length - 1][3],
    },
  });
  const base = { brokerId: fx.brokerId, accountId, positionId: p.id, symbolId: fx.symbolId };
  const voidedAt = o.status === "VOIDED" ? new Date() : null;
  const open = await prisma.deal.create({ data: { ...base, orderId: order.id, side: "BUY", entry: "IN", reason: "CLIENT", volume: D(lots), price: D(100), commission: D("-0.5"), executedAt: ago(o.opened ?? 40), voidedAt } });
  if (o.flip) {
    await prisma.deal.create({ data: { ...base, side: "SELL", entry: "OUT", reason: "REVERSE", volume: D(lots), price: D(100), executedAt: ago(5), voidedAt } });
    await prisma.deal.create({ data: { ...base, side: "SELL", entry: "IN", reason: "REVERSE", volume: D(lots), price: D(100), executedAt: ago(5), voidedAt } });
  }
  const tickets: bigint[] = [open.ticket];
  for (const [v, price, profit, at] of closes) {
    const t = await prisma.transaction.create({
      data: { brokerId: fx.brokerId, accountId, type: "TRADE_PNL", status: "COMPLETED", amount: D(profit), balanceBefore: D(0), balanceAfter: D(profit), referenceType: "Position", referenceId: p.id, createdAt: at },
    });
    const d = await prisma.deal.create({ data: { ...base, side: "SELL", entry: "OUT", reason: "CLIENT", volume: D(v), price: D(price), profit: D(profit), transactionId: t.id, executedAt: at, voidedAt } });
    tickets.push(d.ticket);
  }
  return { p, tickets };
}

async function csv(fx: Fx) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "MANAGER", brokerId: fx.brokerId } as never);
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.text()).trim().split(/\r?\n/);
}

describe("Reports trading CSV", () => {
  it("the MT5 Deals report of the last 30 days (reader reports_trading)", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    // closed in two pieces: the first 35 days ago (out of range), the last 3 days ago
    const multi = await trade(fx, fx.live, "1.00", [["0.40", "110", "4", ago(35)], ["0.60", "120", "12", ago(3)]], { status: "CLOSED" });
    // still open, a partial 2 days ago
    const open = await trade(fx, fx.live, "2.00", [["0.50", "90", "-5", ago(2)]], { status: "OPEN", opened: 4 });
    // flipped in place, then closed: only the real close
    const flipped = await trade(fx, fx.live, "0.30", [["0.30", "101", "0.3", ago(1)]], { status: "CLOSED", flip: true });
    // not in the report: a demo account and a voided trade
    await trade(fx, fx.demo, "1.00", [["1.00", "105", "5", ago(1)]], { status: "CLOSED" });
    await trade(fx, fx.live, "1.00", [["1.00", "105", "5", ago(1)]], { status: "VOIDED" });

    process.env.DEAL_READS = "reports_trading";
    const [head, ...rows] = await csv(fx);
    expect(head).toBe("Time,Deal,Position,Account,Symbol,Side,Entry,Volume,Price,Commission,Swap,Profit");
    // deal, position, side, entry, volume, price, commission, profit
    const cut = rows.map((r) => r.split(",")).map((c) => [c[1], c[2], c[5], c[6], c[7], c[8], c[9], c[11]]);
    const t = (x: { p: { ticket: number } }) => String(x.p.ticket);
    expect(cut).toEqual([
      [flipped.tickets[1].toString(), t(flipped), "SELL", "OUT", "0.30", "101.00", "0.00", "0.30"],
      [open.tickets[1].toString(), t(open), "SELL", "OUT", "0.50", "90.00", "0.00", "-5.00"],
      [multi.tickets[2].toString(), t(multi), "SELL", "OUT", "0.60", "120.00", "0.00", "12.00"],
      [open.tickets[0].toString(), t(open), "BUY", "IN", "2.00", "100.00", "0.50", "0.00"],
    ]);

    // flag off: the positions report (closed positions only, closedAt in range)
    delete process.env.DEAL_READS;
    const [, ...old] = await csv(fx);
    expect(old.length).toBe(2);
  });
});
