import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, type TransactionType } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Ranged account summary (lib/account-summary.ts). Pure tests of the summary math, then one account built through the
// REAL write paths (commission charge + IN deal, closePositionInTx for partial / full closes with the credit a loss uses
// and the negative-balance write-off, the closed-trade void) plus ledger rows booked the way their own routes book them
// (deposit, withdrawal requested then approved, a pending withdrawal, transfers, a credit change, swap, an adjustment),
// against the scratch database. The reconciliation identity is asserted for every range, and adjacent ranges chain.
vi.mock("@/lib/account-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-auth")>()),
  getAccountSession: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { bookedAt, movesBalance, parseRange, summarize, summarizeAccount, summarizeAccounts, type AccountSummary, type LedgerRow } from "@/lib/account-summary";
import { INITIAL_BALANCE_NOTE, LIVE_STARTING_BALANCE_NOTE } from "@/lib/initial-balance";
import { closePositionInTx } from "@/lib/position-close";
import { chargeCommission } from "@/lib/group-pricing";
import { writeOpenDealInTx } from "@/lib/deals";
import { executeVoid } from "@/lib/position-actions";
import { GET as tradeSummary } from "@/app/api/trade/summary/route";
import { GET as manageSummary } from "@/app/api/manage/accounts/[id]/summary/route";
import { GET as manageMany } from "@/app/api/manage/accounts/summary/route";

const D = (v: string | number) => new Prisma.Decimal(v);
const H = 3_600_000;

/// The identity of lib/account-summary.ts, recomputed from the response's own strings.
function identity(s: AccountSummary) {
  const n = (x: string) => D(x);
  const f = s.funds, t = s.trades, v = s.voided;
  return n(s.openingBalance).add(n(f.deposits)).sub(n(f.withdrawals)).add(n(f.creditUsed)).add(n(f.adjustments)).add(n(f.transfersIn)).sub(n(f.transfersOut))
    .add(n(f.nbp)).add(n(f.ibCommission)).add(n(t.grossPnl)).sub(n(t.commission)).sub(n(t.swap))
    .add(n(v.grossPnl)).sub(n(v.commission)).add(n(v.reversal)).add(n(f.deletedTrades));
}

// ------------------------------------------------------------------------------------------------ pure
describe("account summary (pure)", () => {
  const row = (_id: string, type: TransactionType, amount: string, _before: string, _after: string, at: number, approvedAt?: number): LedgerRow => ({
    type, amount: D(amount), referenceType: null, createdAt: new Date(at), updatedAt: new Date(approvedAt ?? at),
  });

  it("a deposit / withdrawal is booked when approved, every other row when written", () => {
    expect(bookedAt(row("a", "WITHDRAWAL", "-5", "10", "5", 1000, 9000)).getTime()).toBe(9000);
    expect(bookedAt(row("b", "TRADE_PNL", "5", "10", "15", 1000, 9000)).getTime()).toBe(1000);
  });

  it("a credit change moves the credit, never the balance; every other completed row moves the balance", () => {
    expect(movesBalance(row("a", "CREDIT_IN", "300", "0", "0", 1))).toBe(false);
    expect(movesBalance(row("b", "CREDIT_OUT", "-300", "0", "0", 1))).toBe(false);
    expect(movesBalance(row("c", "CREDIT", "30", "-50", "-20", 1))).toBe(true);   // credit a loss used: adds to the balance
    expect(movesBalance(row("d", "NEGATIVE_BALANCE_PROTECTION", "20", "-20", "0", 1))).toBe(true);
  });

  it("closes, wins, commission when charged, swap as charged, credit changes outside the balance", () => {
    const s = summarize({
      account: { id: "acc", accountNumber: "1", currency: "USD" },
      range: { from: new Date(0), to: new Date(10_000) },
      openingBalance: D(1000),
      closingBalance: D("1093.5"),
      ledger: [
        row("1", "DEPOSIT", "100", "1000", "1100", 1),
        row("2", "SWAP", "-1.5", "0", "0", 2),
        row("3", "CREDIT_IN", "300", "0", "0", 3),
        row("4", "TRANSFER_OUT", "-20", "0", "0", 4),
      ],
      deals: [
        { entry: "IN", reason: "CLIENT", volume: D(1), profit: D(0), commission: D(-5), voidedAt: null, transactionId: "c" },
        { entry: "OUT", reason: "CLIENT", volume: D("0.4"), profit: D(30), commission: D(0), voidedAt: null, transactionId: "t1" },
        { entry: "OUT_BY", reason: "CLOSE_BY", volume: D("0.6"), profit: D(-10), commission: D(0), voidedAt: null, transactionId: "t2" },
        { entry: "OUT", reason: "REVERSE", volume: D(1), profit: D(0), commission: D(0), voidedAt: null, transactionId: null },
      ],
      // the count: closed positions whose final close is in the range, won / lost on all their closes
      positions: [
        { id: "p1", status: "CLOSED", closes: [{ executedAt: new Date(5), profit: D(30) }, { executedAt: new Date(6), profit: D(-10) }] },   // partials merge: 1 trade, +20
        { id: "p2", status: "OPEN", closes: [{ executedAt: new Date(7), profit: D(5) }] },                                                     // still open: no trade
        { id: "p3", status: "CLOSED", closes: [{ executedAt: new Date(-5), profit: D(-50) }, { executedAt: new Date(8), profit: D(10) }] },  // final close inside: a loss of -40
        { id: "p4", status: "CLOSED", closes: [{ executedAt: new Date(9), profit: D(1) }, { executedAt: new Date(20_000), profit: D(1) }] }, // final close after the range
        { id: "p5", status: "CLOSED", closes: [{ executedAt: new Date(9), profit: D(0) }] },                                                   // flat: a trade, neither won nor lost
      ],
    });
    // P/L, volume and costs stay sums over the closes (the deals); the count is positions
    expect(s.trades).toEqual({ count: 3, wins: 1, losses: 1, winRate: "33.33", volumeLots: "1.00", grossPnl: "20.00", commission: "5.00", swap: "1.50", netPnl: "13.50" });
    expect(s.voided).toEqual({ count: 0, volumeLots: "0.00", grossPnl: "0.00", commission: "0.00", reversal: "0.00", net: "0.00" });
    expect(s.funds.creditIn).toBe("300.00");
    expect(s.funds.transfersOut).toBe("20.00");
    expect(s.reconciliation).toEqual({ computedClosing: "1093.50", difference: "0.00", ok: true });
    expect(s.net).toBe("93.50");
  });

  it("the account-creation funding is its own figure inside adjustments; a voided / deleted position is no trade", () => {
    const note = (type: TransactionType, amount: string, n: string | null): LedgerRow => ({ type, amount: D(amount), referenceType: null, note: n, createdAt: new Date(1), updatedAt: new Date(1) });
    const s = summarize({
      account: { id: "acc", accountNumber: "1", currency: "USD" },
      range: { from: new Date(0), to: new Date(10_000) },
      openingBalance: D(0),
      closingBalance: D(1265),
      ledger: [note("ADJUSTMENT", "1000", INITIAL_BALANCE_NOTE), note("ADJUSTMENT", "250", LIVE_STARTING_BALANCE_NOTE), note("ADJUSTMENT", "15", "Goodwill"), note("DEPOSIT", "0", INITIAL_BALANCE_NOTE)],
      deals: [],
      voidedPositionIds: new Set(["v"]),
      deletedPositionIds: new Set(["d"]),
      positions: [
        { id: "v", status: "CLOSED", closes: [{ executedAt: new Date(5), profit: D(3) }] },
        { id: "d", status: "CLOSED", closes: [{ executedAt: new Date(5), profit: D(3) }] },
        { id: "x", status: "VOIDED", closes: [{ executedAt: new Date(5), profit: D(3) }] },
      ],
    });
    expect(s.funds.adjustments).toBe("1265.00");
    expect(s.funds.initialBalance).toBe("1250.00");
    expect(s.trades.count).toBe(0);
    expect(s.reconciliation.ok).toBe(true);
  });

  it("range: defaults to the last 90 days; bad or reversed dates are refused", () => {
    const now = new Date("2026-10-21T00:00:00Z");
    const r = parseRange(new URLSearchParams(), now);
    expect("from" in r && r.to.toISOString() === now.toISOString() && r.from.toISOString() === "2026-07-23T00:00:00.000Z").toBe(true);
    expect(parseRange(new URLSearchParams("from=nope"), now)).toEqual({ error: "from / to must be ISO dates" });
    expect(parseRange(new URLSearchParams("from=2026-10-02&to=2026-10-01"), now)).toEqual({ error: "from must not be after to" });
  });
});

// ------------------------------------------------------------------------------------------------ database
let dbReachable = false;
const brokers: string[] = [];
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "ticket" FROM "Deal" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/account-summary.test.ts: DB unreachable, skipping the database tests");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
}, 60000);

type Fx = { brokerId: string; adminId: string; accountId: string; groupId: string; symbolId: string; symbolName: string };

async function fixture(): Promise<Fx> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Summary ${suffix}`, subdomain: `sum-${suffix}`, dealingModeAt: null, dealingDeskAutoFillAt: null } });
  brokers.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `sum-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.create({ data: { name: `SM${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(5000), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `SMG-${suffix}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: "B_BOOK", dealingMode: "AUTO", isClientSelectable: true } });
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: `4${suffix.slice(0, 7)}`, email: `sum-client-${suffix}@test.local`, passwordHash: "x", fullName: "Summary Client", accountMode: "LIVE", leverage: 100, balance: D(0) },
  });
  return { brokerId: broker.id, adminId: admin.id, accountId: account.id, groupId: group.id, symbolId: symbol.id, symbolName: symbol.name };
}

/// A ledger row booked the way its own route books it: the balance moves (except a credit change and a pending request).
async function book(fx: Fx, type: TransactionType, amount: string, at: Date, opts: { pending?: boolean } = {}) {
  return prisma.$transaction(async (tx) => {
    const acc = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId }, select: { balance: true, credit: true } });
    const creditChange = type === "CREDIT_IN" || type === "CREDIT_OUT";
    const after = creditChange ? acc.balance : acc.balance.add(D(amount));
    if (opts.pending) {
      // a request: nothing moves until it is approved (lib/funds-approval.ts then rewrites balanceBefore / After)
      return tx.transaction.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, type, status: "PENDING", amount: D(amount), balanceBefore: acc.balance, balanceAfter: acc.balance.add(D(amount)), createdAt: at, updatedAt: at } });
    }
    if (creditChange) await tx.account.update({ where: { id: fx.accountId }, data: { credit: acc.credit.add(D(amount)) } });
    else await tx.account.update({ where: { id: fx.accountId }, data: { balance: after } });
    return tx.transaction.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, type, status: "COMPLETED", amount: D(amount), balanceBefore: acc.balance, balanceAfter: after, createdAt: at, updatedAt: at } });
  });
}

/// Approve a pending request at `at` (the claim lib/funds-approval.ts makes: balance before / after rewritten, COMPLETED).
async function approve(fx: Fx, id: string, at: Date) {
  await prisma.$transaction(async (tx) => {
    const acc = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId }, select: { balance: true } });
    const row = await tx.transaction.findUniqueOrThrow({ where: { id } });
    const after = acc.balance.add(row.amount);
    await tx.transaction.update({ where: { id }, data: { status: "COMPLETED", balanceBefore: acc.balance, balanceAfter: after, updatedAt: at } });
    await tx.account.update({ where: { id: fx.accountId }, data: { balance: after } });
  });
}

/// A position opened at `at` with its commission charged and its IN deal (the open path's order), the commission row
/// dated with the fill as a live open writes it.
async function open(fx: Fx, side: "BUY" | "SELL", volume: string, price: string, at: Date, commissionPerLot: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side, type: "MARKET", volume: D(volume), requestedPrice: D(price), idempotencyKey: `sm:${randomUUID()}`, status: "FILLED", filledPrice: D(price), filledAt: at } });
    const p = await tx.position.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side, volume: D(volume), openPrice: D(price), openedAt: at } });
    await chargeCommission(tx, { brokerId: fx.brokerId, accountId: fx.accountId, positionId: p.id, commissionPerLot: D(commissionPerLot), volume: D(volume) });
    await tx.transaction.updateMany({ where: { referenceType: "Position", referenceId: p.id, type: "COMMISSION" }, data: { createdAt: at, updatedAt: at } });
    await writeOpenDealInTx(tx, { positionId: p.id, reason: "CLIENT" });
    return p;
  });
}

/// A close at `at` through closePositionInTx (the rows it writes after the TRADE_PNL one, credit used and the write-off,
/// dated with it as a live close writes them in the same moment).
async function close(fx: Fx, positionId: string, price: string, at: Date, volume?: string) {
  const p = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
  const startedAt = new Date();
  await prisma.$transaction((tx) =>
    closePositionInTx(tx, {
      position: { id: p.id, accountId: p.accountId, brokerId: p.brokerId, side: p.side, openPrice: p.openPrice, volume: p.volume, symbol: { contractSize: D(1) } },
      closePrice: D(price), closeVolume: volume ? D(volume) : undefined, at, deal: { reason: "CLIENT" },
    })
  );
  await prisma.transaction.updateMany({ where: { referenceId: positionId, type: { in: ["CREDIT", "NEGATIVE_BALANCE_PROTECTION"] }, createdAt: { gte: startedAt } }, data: { createdAt: at, updatedAt: at } });
}

describe("account summary over the real write paths", () => {
  it("pending excluded, approval time, transfers, credit change, partial close across the boundary, credit used + write-off, void: every range reconciles and ranges chain", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const t0 = new Date(Date.now() - 20 * 24 * H);
    const at = (hours: number) => new Date(t0.getTime() + hours * H);
    const from = at(24), to = at(120);

    // ---- before the range ----
    await book(fx, "DEPOSIT", "10000", at(0));
    const a = await open(fx, "BUY", "1", "100", at(1), "2");   // commission 2.00 before the range
    await close(fx, a.id, "110", at(12), "0.4");                // partial +4 before the range
    const wd = await book(fx, "WITHDRAWAL", "-500", at(10), { pending: true });   // requested before the range...
    // ---- inside [from, to] ----
    await close(fx, a.id, "95", at(48));                        // ...the rest of the same position closes inside: 0.6 x -5 = -3
    await approve(fx, wd.id, at(72));                           // ...and is approved inside: counted here
    await book(fx, "WITHDRAWAL", "-700", at(73), { pending: true });   // still pending: never counted, no balance moved
    await book(fx, "TRANSFER_IN", "200", at(60));
    await book(fx, "TRANSFER_OUT", "-50", at(62));
    await book(fx, "CREDIT_IN", "300", at(84));                 // credit facility: not balance
    await book(fx, "SWAP", "-1.25", at(36));
    await book(fx, "ADJUSTMENT", "10", at(96));
    const funding = await book(fx, "ADJUSTMENT", "5", at(97));
    await prisma.transaction.update({ where: { id: funding.id }, data: { note: INITIAL_BALANCE_NOTE } });   // as the provisioning books it
    const b = await open(fx, "SELL", "2", "100", at(98), "1.5");   // commission 3.00 inside, closed after the range
    const c = await open(fx, "BUY", "100", "100", at(100), "0.1");  // commission 10.00 inside
    await close(fx, c.id, "0", at(102));                       // -10,000: uses the 300 credit, the rest is written off
    const v = await open(fx, "BUY", "1", "100", at(104), "1");     // commission 1.00 inside
    await close(fx, v.id, "130", at(106));                      // +30 ...
    await prisma.$transaction((tx) => executeVoid(tx, { brokerId: fx.brokerId, positionId: v.id, adminId: fx.adminId }));
    await prisma.transaction.updateMany({ where: { referenceId: v.id, type: "ADJUSTMENT" }, data: { createdAt: at(108), updatedAt: at(108) } });   // ...voided inside
    // ---- after the range ----
    await close(fx, b.id, "90", at(130));                       // +20 after the range
    await book(fx, "DEPOSIT", "1000", at(140));

    const s = await summarizeAccount(fx.accountId, { from, to }, { brokerId: fx.brokerId });
    expect(s.reconciliation).toEqual({ computedClosing: s.closingBalance, difference: "0.00", ok: true });
    expect(identity(s).toFixed(2)).toBe(s.closingBalance);
    // opening: 10,000 - 2 + 4 (the partial before the range); the pending request moved nothing
    expect(s.openingBalance).toBe("10002.00");
    expect(s.funds).toEqual({
      deposits: "0.00", withdrawals: "500.00", creditIn: "300.00", creditOut: "0.00", creditUsed: "300.00", adjustments: "15.00", initialBalance: "5.00",
      transfersIn: "200.00", transfersOut: "50.00", nbp: s.funds.nbp, ibCommission: "0.00", deletedTrades: "0.00",
    });
    expect(D(s.funds.nbp).gt(0)).toBe(true);
    // positions closed inside: A (its partial +4 before the range merges into it: +1, a win) and C (-10,000); V (+30) was
    // voided since: its own line; B closes after the range
    expect(s.trades.count).toBe(2);
    expect(s.trades.wins).toBe(1);
    expect(s.trades.losses).toBe(1);
    expect(s.voided).toEqual({ count: 1, volumeLots: "1.00", grossPnl: "30.00", commission: "1.00", reversal: "-29.00", net: "0.00" });
    expect(s.trades.volumeLots).toBe("100.60");
    expect(s.trades.grossPnl).toBe("-10003.00");   // the closes inside: A's partial before the range is not in the sum
    expect(s.trades.commission).toBe("13.00");   // B 3 + C 10 charged inside (V's 1 is in the voided line); A's 2 was before
    expect(s.trades.swap).toBe("1.25");
    expect(s.closingBalance).toBe("0.00");   // the write-off left the account at zero; the adjustment / void came after it

    // adjacent ranges chain: before + inside + after = everything, each reconciles
    const before = await summarizeAccount(fx.accountId, { from: at(-1), to: new Date(from.getTime() - 1) });
    const after = await summarizeAccount(fx.accountId, { from: new Date(to.getTime() + 1), to: at(200) });
    const all = await summarizeAccount(fx.accountId, { from: at(-1), to: at(200) });
    for (const r of [before, after, all]) expect(r.reconciliation.ok).toBe(true);
    expect(before.closingBalance).toBe(s.openingBalance);
    expect(after.openingBalance).toBe(s.closingBalance);
    expect(all.trades.count).toBe(before.trades.count + s.trades.count + after.trades.count);
    expect(all.openingBalance).toBe("0.00");
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId }, select: { balance: true } });
    expect(all.closingBalance).toBe(acc.balance.toFixed(2));
    expect(before.trades.count).toBe(0);   // A's partial close: A was still open, so no trade yet (its P/L is in the sum)
    expect(before.trades.grossPnl).toBe("4.00");
    expect(after.trades.count).toBe(1);    // B
    expect(after.trades.grossPnl).toBe("20.00");
  }, 60000);

  it("balances come from the amounts: right for an account funded with no ledger row and for a wrong balance snapshot; a ledger row with no deal shows in the check", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const at = (h: number) => new Date(Date.now() - 50 * H + h * H);
    await prisma.account.update({ where: { id: fx.accountId }, data: { balance: D(5000) } });   // funded at creation, no ledger row (3 live accounts)
    await book(fx, "DEPOSIT", "100", at(1));
    // an old TRADE_PNL row whose stored balanceBefore / After are wrong (concurrent closes before the 2026-09-23 lock fix)
    await prisma.transaction.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, type: "TRADE_PNL", status: "COMPLETED", amount: D(-40), balanceBefore: D(9999), balanceAfter: D(9959), createdAt: at(2), updatedAt: at(2) } });
    await prisma.account.update({ where: { id: fx.accountId }, data: { balance: { decrement: D(40) } } });
    await book(fx, "ADJUSTMENT", "15", at(3));
    const all = await summarizeAccount(fx.accountId, { from: at(-1), to: at(10) });
    expect(all.openingBalance).toBe("5000.00");
    expect(all.closingBalance).toBe("5075.00");
    expect(all.funds.deposits).toBe("100.00");
    // the orphan row has no deal, so the trade line cannot explain it: the check says so instead of hiding it
    expect(all.reconciliation).toEqual({ computedClosing: "5115.00", difference: "-40.00", ok: false });
    const late = await summarizeAccount(fx.accountId, { from: at(2.5), to: at(10) });
    expect(late.openingBalance).toBe("5060.00");
    expect(late.reconciliation.ok).toBe(true);
  }, 60000);

  it("routes: the trader's own account; staff scoped to their broker; statements per group with a total per currency", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const other = await fixture();
    await book(fx, "DEPOSIT", "250", new Date(Date.now() - 2 * H));
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId } as never);
    const t = await tradeSummary(new NextRequest("http://x/api/trade/summary"));
    expect(t.status).toBe(200);
    const tj = await t.json();
    expect(tj.funds.deposits).toBe("250.00");
    expect(tj.reconciliation.ok).toBe(true);
    expect((await tradeSummary(new NextRequest("http://x/api/trade/summary?from=bad"))).status).toBe(400);
    vi.mocked(getAccountSession).mockResolvedValue(null as never);
    expect((await tradeSummary(new NextRequest("http://x/api/trade/summary"))).status).toBe(401);

    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, brokerId: fx.brokerId, role: "MANAGER" } as never);
    const ok = await manageSummary(new NextRequest(`http://x/api/manage/accounts/${fx.accountId}/summary`), { params: Promise.resolve({ id: fx.accountId }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).closingBalance).toBe("250.00");
    const foreign = await manageSummary(new NextRequest(`http://x/api/manage/accounts/${other.accountId}/summary`), { params: Promise.resolve({ id: other.accountId }) });
    expect(foreign.status).toBe(404);   // another broker's account

    const many = await manageMany(new NextRequest(`http://x/api/manage/accounts/summary?groupId=${fx.groupId}&accountIds=${other.accountId}`));
    expect(many.status).toBe(200);
    const mj = await many.json();
    expect(mj.accounts.map((x: AccountSummary) => x.accountId)).toEqual([fx.accountId]);   // the other broker's id is left out
    expect(mj.totals).toHaveLength(1);
    expect(mj.totals[0]).toMatchObject({ currency: "USD", accounts: 1, closingBalance: "250.00", reconciled: true });
    expect((await manageMany(new NextRequest("http://x/api/manage/accounts/summary"))).status).toBe(400);
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, brokerId: fx.brokerId, role: "TRADER" } as never);
    expect((await manageSummary(new NextRequest("http://x"), { params: Promise.resolve({ id: fx.accountId }) })).status).toBe(403);

    // group statement of several accounts
    const r = await summarizeAccounts({ brokerId: fx.brokerId, groupId: fx.groupId }, { from: new Date(Date.now() - 24 * H), to: new Date() });
    expect(r.accounts).toHaveLength(1);
  }, 60000);
});
