import "server-only";
import { Prisma, type TransactionType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Ranged account summary: the one data source of the MT5-style history summary bar (terminal + backoffice client view)
// and of account / group statements. Owner definitions (2026-10-21):
//   1. trade P/L comes from the Deal rows (OUT / OUT_BY), not the TRADE_PNL ledger rows;
//   2. a "trade" is each close (each OUT / OUT_BY deal), counted at the deal's executedAt;
//   3. credit (CREDIT_IN / CREDIT_OUT) is its own line; adjustments, transfers and negative-balance protection are their own
//      lines too, never folded into deposits / withdrawals;
//   4. completed Transaction rows only (pending / rejected / cancelled are left out);
//   5. commission is counted when it is charged (the IN deal), so the period reconciles:
//      openingBalance + deposits - withdrawals + creditUsed + adjustments + transfersIn - transfersOut + nbp + ibCommission
//        + grossPnl - commission - swap = closingBalance.
// Three facts of the ledger shape that identity (each asserted in lib/account-summary.test.ts):
//   - swap is booked DAILY by the rollover (SWAP rows); a close only attributes a share of it (Deal.swap, no money moves),
//     so the period's swap is the SWAP rows booked in it, by the same "counted when charged" rule as commission;
//   - CREDIT_IN / CREDIT_OUT change Account.credit, never the balance (balanceBefore = balanceAfter): they are reported
//     but are not in the identity. The credit a closing LOSS used (type CREDIT) does move the balance: creditUsed;
//   - a deposit / withdrawal moves the balance when it is approved (the PENDING row turns COMPLETED, updatedAt), not when it
//     was requested (createdAt): that is the time the range filters it on. Every other row is written once, at createdAt.
// A voided trade keeps its deals (voidedAt set) and its ledger rows; the void books one ADJUSTMENT that reverses them. So
// voided deals stay in the trade money (and are counted in trades.voided) and the reversal is in adjustments: the
// identity holds across a void, in whichever period each half falls.
// Opening / closing balance: the balance at that moment = today's Account.balance minus every balance-moving amount booked
// after it, read in one snapshot. Not the stored balanceAfter of the last row: on production (read-only check 2026-10-21)
// every account's ledger AMOUNTS add up to its balance exactly, but 2 accounts carry wrong balanceBefore / balanceAfter
// snapshots on old TRADE_PNL rows (concurrent closes before the 2026-09-23 lock fix) and 3 were funded at creation with no
// ledger row, so "balanceAfter of the last row" was off by up to 50,000 there.

const ZERO = new Prisma.Decimal(0);
const APPROVED_LATER: TransactionType[] = ["DEPOSIT", "WITHDRAWAL"];
const CREDIT_ONLY: TransactionType[] = ["CREDIT_IN", "CREDIT_OUT"];   // move Account.credit, never the balance

export type SummaryRange = { from: Date; to: Date };

export type AccountSummary = {
  accountId: string;
  accountNumber: string;
  currency: string;
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  trades: {
    count: number;
    wins: number;
    losses: number;
    winRate: string; // % of count, 2 dp ("0.00" with no trades)
    volumeLots: string;
    grossPnl: string; // signed
    commission: string; // cost: positive = charged
    swap: string; // cost: positive = charged, negative = swap paid to the account
    netPnl: string; // grossPnl - commission - swap
    voided: number; // closes in the period whose trade was voided since (their money is in, the reversal is in adjustments)
  };
  funds: {
    deposits: string;
    withdrawals: string; // positive = money out
    creditIn: string; // credit facility granted (not balance)
    creditOut: string; // credit facility removed (not balance)
    creditUsed: string; // credit a closing loss consumed: adds to the balance
    adjustments: string; // signed (void reversals included)
    transfersIn: string;
    transfersOut: string; // positive = money out
    nbp: string; // negative-balance protection write-offs: add to the balance
    ibCommission: string; // IB commission paid out to this account (COMMISSION rows not tied to a position)
  };
  net: string; // closingBalance - openingBalance
  reconciliation: { computedClosing: string; difference: string; ok: boolean };
};

// ------------------------------------------------------------------------------------------------ pure part
export type LedgerRow = {
  type: TransactionType;
  amount: Prisma.Decimal;
  referenceType: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type DealRow = {
  entry: "IN" | "OUT" | "OUT_BY" | "INOUT";
  reason: string;
  volume: Prisma.Decimal;
  profit: Prisma.Decimal;
  commission: Prisma.Decimal;
  voidedAt: Date | null;
  transactionId: string | null;
};

/// When a completed row moved the balance (see the header).
export function bookedAt(r: Pick<LedgerRow, "type" | "createdAt" | "updatedAt">): Date {
  return APPROVED_LATER.includes(r.type) ? r.updatedAt : r.createdAt;
}

/// Whether a completed row moved the balance (a credit change does not).
export function movesBalance(r: Pick<LedgerRow, "type">): boolean {
  return !CREDIT_ONLY.includes(r.type);
}

const money = (d: Prisma.Decimal) => d.toFixed(2);

/// The summary from the rows of one account: ledger rows booked inside the range, deals executed inside it, and the
/// opening / closing balances. Pure: lib/account-summary.test.ts drives it directly as well as through the database.
export function summarize(input: {
  account: { id: string; accountNumber: string; currency: string };
  range: SummaryRange;
  openingBalance: Prisma.Decimal;
  closingBalance: Prisma.Decimal;
  ledger: LedgerRow[];
  deals: DealRow[];
}): AccountSummary {
  const sum = (pred: (r: LedgerRow) => boolean) => input.ledger.filter(pred).reduce((s, r) => s.add(r.amount), ZERO);
  const of = (t: TransactionType) => (r: LedgerRow) => r.type === t;

  const deposits = sum(of("DEPOSIT"));
  const withdrawals = sum(of("WITHDRAWAL")).neg();
  const creditIn = sum(of("CREDIT_IN"));
  const creditOut = sum(of("CREDIT_OUT")).neg();
  const creditUsed = sum(of("CREDIT"));
  const adjustments = sum(of("ADJUSTMENT"));
  const transfersIn = sum(of("TRANSFER_IN"));
  const transfersOut = sum(of("TRANSFER_OUT")).neg();
  const nbp = sum(of("NEGATIVE_BALANCE_PROTECTION"));
  const ibCommission = sum((r) => r.type === "COMMISSION" && r.referenceType !== "Position");
  const swap = sum(of("SWAP")).neg();

  // a close = an OUT / OUT_BY deal; a staff reverse in place writes an OUT with no ledger row and profit 0: not a close
  const closes = input.deals.filter((d) => (d.entry === "OUT" || d.entry === "OUT_BY") && !(d.reason === "REVERSE" && d.transactionId === null));
  const grossPnl = closes.reduce((s, d) => s.add(d.profit), ZERO);
  const volume = closes.reduce((s, d) => s.add(d.volume), ZERO);
  const wins = closes.filter((d) => d.profit.gt(0)).length;
  const losses = closes.filter((d) => d.profit.lt(0)).length;
  // commission when charged: the IN deals executed in the period (Deal.commission is the signed ledger amount, a debit)
  const commission = input.deals.filter((d) => d.entry === "IN").reduce((s, d) => s.add(d.commission), ZERO).neg();
  const netPnl = grossPnl.sub(commission).sub(swap);

  const computedClosing = input.openingBalance
    .add(deposits).sub(withdrawals).add(creditUsed).add(adjustments).add(transfersIn).sub(transfersOut).add(nbp).add(ibCommission)
    .add(grossPnl).sub(commission).sub(swap);
  const difference = input.closingBalance.sub(computedClosing);

  return {
    accountId: input.account.id,
    accountNumber: input.account.accountNumber,
    currency: input.account.currency,
    from: input.range.from.toISOString(),
    to: input.range.to.toISOString(),
    openingBalance: money(input.openingBalance),
    closingBalance: money(input.closingBalance),
    trades: {
      count: closes.length,
      wins,
      losses,
      winRate: closes.length === 0 ? "0.00" : ((wins / closes.length) * 100).toFixed(2),
      volumeLots: volume.toFixed(2),
      grossPnl: money(grossPnl),
      commission: money(commission),
      swap: money(swap),
      netPnl: money(netPnl),
      voided: closes.filter((d) => d.voidedAt !== null).length,
    },
    funds: {
      deposits: money(deposits),
      withdrawals: money(withdrawals),
      creditIn: money(creditIn),
      creditOut: money(creditOut),
      creditUsed: money(creditUsed),
      adjustments: money(adjustments),
      transfersIn: money(transfersIn),
      transfersOut: money(transfersOut),
      nbp: money(nbp),
      ibCommission: money(ibCommission),
    },
    net: money(input.closingBalance.sub(input.openingBalance)),
    // ledger amounts carry 4 dp: a difference under half a cent is rounding, not a gap
    reconciliation: { computedClosing: money(computedClosing), difference: money(difference), ok: difference.abs().lt(new Prisma.Decimal("0.005")) },
  };
}

// ------------------------------------------------------------------------------------------------ database part
const LEDGER_SELECT = { type: true, amount: true, referenceType: true, createdAt: true, updatedAt: true } as const;
type Tx = Prisma.TransactionClient;

/// The sum of the balance-moving amounts booked after a moment (`gt`) or from it on (`gte`): today's balance minus this is
/// the balance at that moment (see the header).
async function bookedSince(tx: Tx, accountId: string, bound: { gt: Date } | { gte: Date }): Promise<Prisma.Decimal> {
  const written = await tx.transaction.aggregate({ where: { accountId, status: "COMPLETED", type: { notIn: [...APPROVED_LATER, ...CREDIT_ONLY] }, createdAt: bound }, _sum: { amount: true } });
  const approved = await tx.transaction.aggregate({ where: { accountId, status: "COMPLETED", type: { in: APPROVED_LATER }, updatedAt: bound }, _sum: { amount: true } });
  return (written._sum.amount ?? ZERO).add(approved._sum.amount ?? ZERO);
}

export class SummaryNotFoundError extends Error {}
export class SummaryTooManyError extends Error {}

/// The summary of one account over [from, to] (both inclusive). `brokerId` scopes it like every manage route: an account
/// of another broker is not found.
export async function summarizeAccount(accountId: string, range: SummaryRange, scope: { brokerId?: string } = {}): Promise<AccountSummary> {
  const inRange = { gte: range.from, lte: range.to };
  // one snapshot: a close / deposit landing while this reads cannot make the balances and the lines disagree
  return prisma.$transaction(
    async (tx) => {
      const account = await tx.account.findUnique({ where: { id: accountId }, select: { id: true, brokerId: true, accountNumber: true, currency: true, balance: true } });
      if (!account || (scope.brokerId !== undefined && account.brokerId !== scope.brokerId)) throw new SummaryNotFoundError("account not found");
      const openingBalance = account.balance.sub(await bookedSince(tx, accountId, { gte: range.from }));
      const closingBalance = account.balance.sub(await bookedSince(tx, accountId, { gt: range.to }));
      const written = await tx.transaction.findMany({ where: { accountId, status: "COMPLETED", type: { notIn: APPROVED_LATER }, createdAt: inRange }, select: LEDGER_SELECT });
      const approved = await tx.transaction.findMany({ where: { accountId, status: "COMPLETED", type: { in: APPROVED_LATER }, updatedAt: inRange }, select: LEDGER_SELECT });
      const deals = await tx.deal.findMany({
        where: { accountId, executedAt: inRange },
        select: { entry: true, reason: true, volume: true, profit: true, commission: true, voidedAt: true, transactionId: true },
      });
      return summarize({ account, range, openingBalance, closingBalance, ledger: [...written, ...approved], deals });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

/// Statements: several accounts (by id) and / or every account of a group, each summarized, plus one total per currency.
export async function summarizeAccounts(params: { brokerId: string; accountIds?: string[]; groupId?: string; max?: number }, range: SummaryRange) {
  const ids = new Set(params.accountIds ?? []);
  if (params.groupId) {
    const members = await prisma.account.findMany({ where: { brokerId: params.brokerId, groupId: params.groupId }, select: { id: true } });
    for (const m of members) ids.add(m.id);
  }
  const owned = await prisma.account.findMany({ where: { brokerId: params.brokerId, id: { in: [...ids] } }, select: { id: true }, orderBy: { accountNumber: "asc" } });
  if (params.max !== undefined && owned.length > params.max) throw new SummaryTooManyError(`at most ${params.max} accounts per call`);
  const accounts: AccountSummary[] = [];
  for (const a of owned) accounts.push(await summarizeAccount(a.id, range, { brokerId: params.brokerId }));
  return { from: range.from.toISOString(), to: range.to.toISOString(), accounts, totals: totalsByCurrency(accounts) };
}

/// One total per account currency (amounts in different currencies are never added together).
export function totalsByCurrency(accounts: AccountSummary[]) {
  const D = (s: string) => new Prisma.Decimal(s);
  const out = new Map<string, Record<string, unknown>>();
  for (const cur of [...new Set(accounts.map((a) => a.currency))].sort()) {
    const list = accounts.filter((a) => a.currency === cur);
    const add = (pick: (a: AccountSummary) => string) => money(list.reduce((s, a) => s.add(D(pick(a))), ZERO));
    const count = list.reduce((s, a) => s + a.trades.count, 0);
    const wins = list.reduce((s, a) => s + a.trades.wins, 0);
    out.set(cur, {
      currency: cur,
      accounts: list.length,
      openingBalance: add((a) => a.openingBalance),
      closingBalance: add((a) => a.closingBalance),
      trades: {
        count,
        wins,
        losses: list.reduce((s, a) => s + a.trades.losses, 0),
        winRate: count === 0 ? "0.00" : ((wins / count) * 100).toFixed(2),
        volumeLots: list.reduce((s, a) => s.add(D(a.trades.volumeLots)), ZERO).toFixed(2),
        grossPnl: add((a) => a.trades.grossPnl),
        commission: add((a) => a.trades.commission),
        swap: add((a) => a.trades.swap),
        netPnl: add((a) => a.trades.netPnl),
        voided: list.reduce((s, a) => s + a.trades.voided, 0),
      },
      funds: Object.fromEntries((Object.keys(list[0].funds) as (keyof AccountSummary["funds"])[]).map((k) => [k, add((a) => a.funds[k])])),
      net: add((a) => a.net),
      reconciled: list.every((a) => a.reconciliation.ok),
    });
  }
  return [...out.values()];
}

/// ?from / ?to (ISO). Defaults: to = now, from = 90 days before to. Errors as one line for a 400.
export function parseRange(sp: URLSearchParams, now = new Date()): SummaryRange | { error: string } {
  const rawTo = sp.get("to");
  const rawFrom = sp.get("from");
  const to = rawTo ? new Date(rawTo) : now;
  const from = rawFrom ? new Date(rawFrom) : new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) return { error: "from / to must be ISO dates" };
  if (from > to) return { error: "from must not be after to" };
  return { from, to };
}
