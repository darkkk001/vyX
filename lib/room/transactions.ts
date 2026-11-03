import "server-only";
import { Prisma, TransactionType, TransactionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Trader's Room money rows (Dashboard "Recent transactions", History "Transactions"). Balance movements only, the
// rows hidden by a voided trade stay hidden (same filter as /api/trade/transactions). An internal transfer between two
// of the client's own accounts is ONE row "from -> to" (its TRANSFER_OUT leg); a transfer in from an account the client
// does not own (staff move) shows as its own TRANSFER_IN leg.

export type RoomTxType = "Deposit" | "Withdrawal" | "Transfer" | "Credit" | "Adjustment";
export type RoomTxRow = {
  id: string;
  ref: string; // TX-<8 chars>
  at: string;
  type: RoomTxType;
  account: string; // "50004210" or "50004210 → 50004388"
  method: string;
  amount: string; // signed, 2 dp, account currency
  currency: string;
  status: "Completed" | "Pending" | "Rejected" | "Cancelled";
};

const TYPE_GROUPS: Record<RoomTxType, TransactionType[]> = {
  Deposit: ["DEPOSIT"],
  Withdrawal: ["WITHDRAWAL"],
  Transfer: ["TRANSFER_OUT", "TRANSFER_IN"],
  Credit: ["CREDIT_IN", "CREDIT_OUT"],
  Adjustment: ["ADJUSTMENT", "NEGATIVE_BALANCE_PROTECTION"],
};
export const ROOM_TX_TYPES = Object.keys(TYPE_GROUPS) as RoomTxType[];

const STATUS: Record<TransactionStatus, RoomTxRow["status"]> = { COMPLETED: "Completed", PENDING: "Pending", REJECTED: "Rejected", CANCELLED: "Cancelled" };
const METHOD: Record<string, string> = { BANK_TRANSFER: "Bank transfer", USDT_TRC20: "USDT · TRC-20", USDT_BEP20: "USDT · BEP-20", BTC: "Bitcoin", ETH: "Ethereum" };

export function maskAddress(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.trim();
  return t.length <= 8 ? t : `${t.slice(0, 4)}····${t.slice(-4)}`;
}

const TRANSFER_NOTE = /^Transfer (to|from) (\d+)/;

export type RoomTxFilter = { accountIds: string[]; types?: RoomTxType[]; from?: Date; to?: Date };

function whereFor(f: RoomTxFilter): Prisma.TransactionWhereInput {
  const types = (f.types && f.types.length ? f.types : ROOM_TX_TYPES).flatMap((t) => TYPE_GROUPS[t]);
  return {
    accountId: { in: f.accountIds },
    type: { in: types },
    hiddenForPositionId: null,
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } } : {}),
  };
}

const SELECT = {
  id: true, type: true, status: true, amount: true, note: true, createdAt: true, destinationAddress: true,
  account: { select: { accountNumber: true, currency: true } },
  paymentMethod: { select: { type: true } },
} satisfies Prisma.TransactionSelect;
type Raw = Prisma.TransactionGetPayload<{ select: typeof SELECT }>;

function toRow(t: Raw, ownNumbers: Set<string>): RoomTxRow | null {
  const own = t.account.accountNumber;
  let type: RoomTxType = "Adjustment";
  for (const k of ROOM_TX_TYPES) if (TYPE_GROUPS[k].includes(t.type)) type = k;
  let account = own;
  let amount = t.amount.toFixed(2);
  let method = t.paymentMethod ? METHOD[t.paymentMethod.type] ?? t.paymentMethod.type : "";
  if (type === "Transfer") {
    const m = t.note ? TRANSFER_NOTE.exec(t.note) : null;
    const other = m?.[2] ?? null;
    // one row per own-to-own transfer: the IN leg is dropped when its source is one of the client's own accounts
    if (t.type === "TRANSFER_IN" && other && ownNumbers.has(other)) return null;
    account = t.type === "TRANSFER_OUT" ? (other ? `${own} → ${other}` : own) : other ? `${other} → ${own}` : own;
    amount = t.amount.abs().toFixed(2);
    method = "Internal";
  } else if (type === "Withdrawal") {
    const dest = maskAddress(t.destinationAddress);
    method = [method, dest].filter(Boolean).join(" · ");
  } else if (type === "Credit") {
    method = "Credit";
  } else if (type === "Adjustment" && !method) {
    method = "Broker";
  }
  return { id: t.id, ref: `TX-${t.id.slice(-8).toUpperCase()}`, at: t.createdAt.toISOString(), type, account, method, amount, currency: t.account.currency, status: STATUS[t.status] };
}

export async function roomTransactions(f: RoomTxFilter, ownNumbers: Set<string>, page: { skip: number; take: number }) {
  const where = whereFor(f);
  // own-to-own IN legs are left out of the read and the count alike (toRow drops any that slip through)
  const countWhere: Prisma.TransactionWhereInput = ownNumbers.size
    ? { AND: [where, { NOT: { type: "TRANSFER_IN", OR: [...ownNumbers].map((n) => ({ note: { startsWith: `Transfer from ${n}:` } })) } }] }
    : where;
  const [raw, total] = await Promise.all([
    prisma.transaction.findMany({ where: countWhere, select: SELECT, orderBy: { createdAt: "desc" }, skip: page.skip, take: page.take }),
    prisma.transaction.count({ where: countWhere }),
  ]);
  return { rows: raw.map((t) => toRow(t, ownNumbers)).filter((r): r is RoomTxRow => r !== null), total };
}
