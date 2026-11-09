import "server-only";
import { prisma } from "@/lib/prisma";
import { METHOD_LABEL } from "@/lib/room/funds";

// The Room Deposit confirmation (owner 2026-11-10): after a deposit request is sent, the same client sends no other deposit
// with the same payment method for 5 minutes (enforced here and in POST /api/room/deposit, shown as a countdown in the
// page); the confirmation card follows the request live (waiting, approved with the new balance, rejected with the reason)
// and shows again when the client comes back while it is still pending.

export const DEPOSIT_COOLDOWN_SECONDS = 300;
// a pending request older than this no longer brings the card back on its own
const RESUME_HOURS = 24;

export type DepositView = {
  id: string;
  state: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  amount: string;
  currency: string;
  accountNumber: string;
  method: string;
  reference: string | null;
  sentAt: string;
  decidedAt: string | null;
  reason: string | null;
  // the account balance after the approval (null until approved)
  balance: string | null;
};

const select = {
  id: true, status: true, amount: true, paymentReference: true, reviewNote: true, createdAt: true, updatedAt: true,
  paymentMethod: { select: { type: true } },
  account: { select: { accountNumber: true, currency: true, balance: true } },
} as const;

type Row = { id: string; status: string; amount: { toFixed(n: number): string }; paymentReference: string | null; reviewNote: string | null; createdAt: Date; updatedAt: Date; paymentMethod: { type: keyof typeof METHOD_LABEL } | null; account: { accountNumber: string; currency: string; balance: { toFixed(n: number): string } } };

function view(r: Row): DepositView {
  const state = r.status === "COMPLETED" ? "APPROVED" : r.status === "REJECTED" ? "REJECTED" : r.status === "CANCELLED" ? "CANCELLED" : "PENDING";
  return {
    id: r.id,
    state,
    amount: r.amount.toFixed(2),
    currency: r.account.currency,
    accountNumber: r.account.accountNumber,
    method: r.paymentMethod ? METHOD_LABEL[r.paymentMethod.type] ?? r.paymentMethod.type : "",
    reference: r.paymentReference,
    sentAt: r.createdAt.toISOString(),
    decidedAt: state === "PENDING" ? null : r.updatedAt.toISOString(),
    reason: state === "REJECTED" ? r.reviewNote?.trim() || null : null,
    balance: state === "APPROVED" ? r.account.balance.toFixed(2) : null,
  };
}

/** One of the client's own deposit requests, or null. */
export async function depositView(clientId: string, id: string): Promise<DepositView | null> {
  const r = await prisma.transaction.findFirst({ where: { id, type: "DEPOSIT", account: { clientId } }, select });
  return r ? view(r as unknown as Row) : null;
}

/** The latest Room deposit request still pending (sent in the last 24 h): the card shows again on return. */
export async function pendingDeposit(clientId: string): Promise<DepositView | null> {
  const r = await prisma.transaction.findFirst({
    where: { type: "DEPOSIT", status: "PENDING", paymentReference: { not: null }, account: { clientId }, createdAt: { gte: new Date(Date.now() - RESUME_HOURS * 3600_000) } },
    orderBy: { createdAt: "desc" },
    select,
  });
  return r ? view(r as unknown as Row) : null;
}

/** Per payment method: until when this client may not send another deposit with it (ISO), for methods still waiting. */
export async function depositCooldowns(clientId: string, now = Date.now()): Promise<Record<string, string>> {
  const since = new Date(now - DEPOSIT_COOLDOWN_SECONDS * 1000);
  const rows = await prisma.transaction.findMany({
    where: { type: "DEPOSIT", paymentMethodId: { not: null }, account: { clientId }, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { paymentMethodId: true, createdAt: true },
  });
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.paymentMethodId || out[r.paymentMethodId]) continue;
    out[r.paymentMethodId] = new Date(r.createdAt.getTime() + DEPOSIT_COOLDOWN_SECONDS * 1000).toISOString();
  }
  return out;
}
