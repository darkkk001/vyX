import "server-only";
import { Prisma, type TransactionType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isInitialBalanceRow } from "@/lib/initial-balance";

// Ranged account summary: the one data source of the MT5-style history summary bar (terminal + backoffice client view)
// and of account / group statements. Owner definitions (2026-10-21):
//   1. trade P/L comes from the Deal rows (OUT / OUT_BY), not the TRADE_PNL ledger rows;
//   2. trade P/L, volume and costs sum each close (each OUT / OUT_BY deal) at the deal's executedAt; but the trade COUNT,
//      wins, losses and win rate count CLOSED POSITIONS (owner 2026-10-22): a position counts once, in the range of its
//      final close, won or lost on the P/L of all its closes (partials merge into it). An open position's partial closes
//      add to the P/L sums and to no count;
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
// Voided and deleted trades (Batch D, owner 2026-10-21):
//   - a VOIDED trade keeps its deals (voidedAt set) and ledger rows; the void books one ADJUSTMENT referencing the position
//     that reverses them. Its closes are NOT in `trades` (count, win rate, gross P/L, commission): they are the separate
//     `voided` line { count, volumeLots, grossPnl, commission, reversal, net }, its reversal there and not in adjustments;
//   - a DELETED trade is invisible to the client: its deals are in no line, and its ledger rows (hiddenForPositionId: its
//     P/L, commission, credit, write-off and the delete's reversal) are in no line either. Their net is funds.deletedTrades:
//     0 when the trade and its delete fall in the same range (the delete books its swap refund as a visible SWAP row, so
//     the swap line nets out too), the reversal alone when the trade closed in an earlier range;
//   the identity holds across both, in whichever period each half falls:
//      ... (as above) + voided.grossPnl - voided.commission + voided.reversal + deletedTrades = closingBalance.
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
    count: number; // closed positions (see the header), not closes
    wins: number;
    losses: number;
    winRate: string; // % of count, 2 dp ("0.00" with no trades)
    volumeLots: string;
    grossPnl: string; // signed
    commission: string; // cost: positive = charged
    swap: string; // cost: positive = charged, negative = swap paid to the account
    netPnl: string; // grossPnl - commission - swap
  };
  // trades of the period voided since: their closes and commission, and the reversals booked in the period
  voided: { count: number; volumeLots: string; grossPnl: string; commission: string; reversal: string; net: string };
  funds: {
    deposits: string;
    withdrawals: string; // positive = money out
    creditIn: string; // credit facility granted (not balance)
    creditOut: string; // credit facility removed (not balance)
    creditUsed: string; // credit a closing loss consumed: adds to the balance
    adjustments: string; // signed (void reversals are in voided.reversal, a deleted trade's in deletedTrades)
    initialBalance: string; // of which the account-creation funding (lib/initial-balance.ts): PART of adjustments, not added again
    transfersIn: string;
    transfersOut: string; // positive = money out
    nbp: string; // negative-balance protection write-offs: add to the balance
    ibCommission: string; // IB commission paid out to this account (COMMISSION rows not tied to a position)
    deletedTrades: string; // net of a deleted trade's hidden rows booked in the period (see the header)
  };
  net: string; // closingBalance - openingBalance
  reconciliation: { computedClosing: string; difference: string; ok: boolean };
};

// ------------------------------------------------------------------------------------------------ pure part
export type LedgerRow = {
  type: TransactionType;
  amount: Prisma.Decimal;
  referenceType: string | null;
  referenceId?: string | null;
  hiddenForPositionId?: string | null;
  note?: string | null;
  createdAt: Date;
  updatedAt: Date;
};
/// A position with a close in the range: its status and ALL its closes (any time), for the closed-position count.
export type PositionCloses = { id: string; status: "OPEN" | "CLOSED" | "VOIDED"; closes: { executedAt: Date; profit: Prisma.Decimal }[] };
export type DealRow = {
  positionId?: string;
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

/// A close = an OUT / OUT_BY deal; a staff reverse in place writes an OUT with no ledger row and profit 0: not a close.
function isCloseDeal(d: Pick<DealRow, "entry" | "reason" | "transactionId">): boolean {
  return (d.entry === "OUT" || d.entry === "OUT_BY") && !(d.reason === "REVERSE" && d.transactionId === null);
}

/// The summary from the rows of one account: ledger rows booked inside the range, deals executed inside it, and the
/// opening / closing balances. Pure: lib/account-summary.test.ts drives it directly as well as through the database.
export function summarize(input: {
  account: { id: string; accountNumber: string; currency: string };
  range: SummaryRange;
  openingBalance: Prisma.Decimal;
  closingBalance: Prisma.Decimal;
  ledger: LedgerRow[];
  deals: DealRow[];
  // positions of these deals / rows that are VOIDED (and not deleted) and that are deleted
  voidedPositionIds?: ReadonlySet<string>;
  deletedPositionIds?: ReadonlySet<string>;
  // the positions of the range's closes (see PositionCloses): the trade count
  positions?: PositionCloses[];
}): AccountSummary {
  const voidedIds = input.voidedPositionIds ?? new Set<string>();
  const deletedIds = input.deletedPositionIds ?? new Set<string>();
  const hidden = input.ledger.filter((r) => r.hiddenForPositionId);
  const visible = input.ledger.filter((r) => !r.hiddenForPositionId);
  const isVoidReversal = (r: LedgerRow) => r.type === "ADJUSTMENT" && r.referenceType === "Position" && !!r.referenceId && voidedIds.has(r.referenceId);
  const sumOf = (rows: LedgerRow[]) => rows.reduce((s, r) => s.add(r.amount), ZERO);
  const sum = (pred: (r: LedgerRow) => boolean) => sumOf(visible.filter(pred));
  const of = (t: TransactionType) => (r: LedgerRow) => r.type === t;

  const deposits = sum(of("DEPOSIT"));
  const withdrawals = sum(of("WITHDRAWAL")).neg();
  const creditIn = sum(of("CREDIT_IN"));
  const creditOut = sum(of("CREDIT_OUT")).neg();
  const creditUsed = sum(of("CREDIT"));
  const adjustments = sum((r) => r.type === "ADJUSTMENT" && !isVoidReversal(r));
  const initialBalance = sum(isInitialBalanceRow);
  const voidReversal = sum(isVoidReversal);
  const deletedTrades = sumOf(hidden);
  const transfersIn = sum(of("TRANSFER_IN"));
  const transfersOut = sum(of("TRANSFER_OUT")).neg();
  const nbp = sum(of("NEGATIVE_BALANCE_PROTECTION"));
  const ibCommission = sum((r) => r.type === "COMMISSION" && r.referenceType !== "Position");
  const swap = sum(of("SWAP")).neg();

  // A deleted trade's deals are in no line; a voided trade's are the `voided` line.
  const shown = input.deals.filter((d) => !(d.positionId && deletedIds.has(d.positionId)));
  const isClose = isCloseDeal;
  const live = shown.filter((d) => d.voidedAt === null);
  const gone = shown.filter((d) => d.voidedAt !== null);
  const closes = live.filter(isClose);
  const voidedCloses = gone.filter(isClose);
  const grossPnl = closes.reduce((s, d) => s.add(d.profit), ZERO);
  const volume = closes.reduce((s, d) => s.add(d.volume), ZERO);
  // the count: closed positions whose final close is in the range, on the P/L of all their closes. Voided / deleted
  // positions are not trades (a voided one is the `voided` line).
  const { from, to } = input.range;
  const trades = (input.positions ?? [])
    .filter((p) => p.status === "CLOSED" && !voidedIds.has(p.id) && !deletedIds.has(p.id) && p.closes.length > 0)
    .filter((p) => {
      const last = Math.max(...p.closes.map((c) => c.executedAt.getTime()));
      return last >= from.getTime() && last <= to.getTime();
    })
    .map((p) => p.closes.reduce((s, c) => s.add(c.profit), ZERO));
  const wins = trades.filter((pnl) => pnl.gt(0)).length;
  const losses = trades.filter((pnl) => pnl.lt(0)).length;
  // commission when charged: the IN deals executed in the period (Deal.commission is the signed ledger amount, a debit)
  const commission = live.filter((d) => d.entry === "IN").reduce((s, d) => s.add(d.commission), ZERO).neg();
  const netPnl = grossPnl.sub(commission).sub(swap);
  const voidedGross = voidedCloses.reduce((s, d) => s.add(d.profit), ZERO);
  const voidedCommission = gone.filter((d) => d.entry === "IN").reduce((s, d) => s.add(d.commission), ZERO).neg();
  const voidedNet = voidedGross.sub(voidedCommission).add(voidReversal);

  const computedClosing = input.openingBalance
    .add(deposits).sub(withdrawals).add(creditUsed).add(adjustments).add(transfersIn).sub(transfersOut).add(nbp).add(ibCommission)
    .add(grossPnl).sub(commission).sub(swap)
    .add(voidedNet).add(deletedTrades);
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
      count: trades.length,
      wins,
      losses,
      winRate: trades.length === 0 ? "0.00" : ((wins / trades.length) * 100).toFixed(2),
      volumeLots: volume.toFixed(2),
      grossPnl: money(grossPnl),
      commission: money(commission),
      swap: money(swap),
      netPnl: money(netPnl),
    },
    voided: {
      count: voidedCloses.length,
      volumeLots: voidedCloses.reduce((s, d) => s.add(d.volume), ZERO).toFixed(2),
      grossPnl: money(voidedGross),
      commission: money(voidedCommission),
      reversal: money(voidReversal),
      net: money(voidedNet),
    },
    funds: {
      deposits: money(deposits),
      withdrawals: money(withdrawals),
      creditIn: money(creditIn),
      creditOut: money(creditOut),
      creditUsed: money(creditUsed),
      adjustments: money(adjustments),
      initialBalance: money(initialBalance),
      transfersIn: money(transfersIn),
      transfersOut: money(transfersOut),
      nbp: money(nbp),
      ibCommission: money(ibCommission),
      deletedTrades: money(deletedTrades),
    },
    net: money(input.closingBalance.sub(input.openingBalance)),
    // ledger amounts carry 4 dp: a difference under half a cent is rounding, not a gap
    reconciliation: { computedClosing: money(computedClosing), difference: money(difference), ok: difference.abs().lt(new Prisma.Decimal("0.005")) },
  };
}

// ------------------------------------------------------------------------------------------------ database part
const LEDGER_SELECT = { type: true, amount: true, referenceType: true, referenceId: true, hiddenForPositionId: true, note: true, createdAt: true, updatedAt: true } as const;
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
        select: { positionId: true, entry: true, reason: true, volume: true, profit: true, commission: true, voidedAt: true, transactionId: true },
      });
      const ledger = [...written, ...approved];
      // which of the positions these deals / rows belong to are voided or deleted
      const positionIds = [...new Set([...deals.map((d) => d.positionId), ...ledger.filter((r) => r.referenceType === "Position" && r.referenceId).map((r) => r.referenceId!)])];
      const states = positionIds.length === 0 ? [] : await tx.position.findMany({ where: { accountId, id: { in: positionIds }, OR: [{ status: "VOIDED" }, { deletedAt: { not: null } }] }, select: { id: true, status: true, deletedAt: true } });
      const deletedPositionIds = new Set(states.filter((p) => p.deletedAt).map((p) => p.id));
      const voidedPositionIds = new Set(states.filter((p) => !p.deletedAt && p.status === "VOIDED").map((p) => p.id));
      // the positions of the range's live closes, with all their closes (a partial may be before the range)
      const closedIds = [...new Set(deals.filter((d) => d.voidedAt === null && isCloseDeal(d)).map((d) => d.positionId))];
      const positions: PositionCloses[] = [];
      if (closedIds.length > 0) {
        const rows = await tx.position.findMany({ where: { accountId, id: { in: closedIds } }, select: { id: true, status: true } });
        const all = await tx.deal.findMany({
          where: { accountId, positionId: { in: closedIds }, entry: { in: ["OUT", "OUT_BY"] }, voidedAt: null },
          select: { positionId: true, entry: true, reason: true, transactionId: true, executedAt: true, profit: true },
        });
        for (const p of rows) positions.push({ id: p.id, status: p.status, closes: all.filter((d) => d.positionId === p.id && isCloseDeal(d)) });
      }
      return summarize({ account, range, openingBalance, closingBalance, ledger, deals, voidedPositionIds, deletedPositionIds, positions });
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
      },
      voided: {
        count: list.reduce((s, a) => s + a.voided.count, 0),
        volumeLots: list.reduce((s, a) => s.add(D(a.voided.volumeLots)), ZERO).toFixed(2),
        grossPnl: add((a) => a.voided.grossPnl),
        commission: add((a) => a.voided.commission),
        reversal: add((a) => a.voided.reversal),
        net: add((a) => a.voided.net),
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
