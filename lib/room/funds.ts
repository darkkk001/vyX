import "server-only";
import crypto from "node:crypto";
import { Prisma, type PaymentMethodType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { loadAccountMarginState } from "@/lib/margin";
import { maskAddress } from "@/lib/room/transactions";

// Trader's Room funds: the broker's methods as the client sees them, the amount an account can withdraw, payment
// references and saved payout methods. Approval stays with the broker (lib/funds-approval.ts); nothing here moves money.

export const METHOD_LABEL: Record<PaymentMethodType, string> = {
  BANK_TRANSFER: "Bank transfer",
  USDT_TRC20: "USDT · TRC-20",
  USDT_BEP20: "USDT · BEP-20",
  BTC: "Bitcoin",
  ETH: "Ethereum",
};

export type RoomMethod = {
  id: string;
  type: PaymentMethodType;
  label: string;
  min: string;
  max: string | null;
  feeLine: string | null;
  processing: string | null;
  bank: { beneficiary: string; bank: string; iban: string; swift: string } | null;
  wallet: string | null;
  instructions: string | null;
};

export async function roomMethods(brokerId: string): Promise<RoomMethod[]> {
  const rows = await prisma.paymentMethod.findMany({ where: { brokerId, enabled: true }, orderBy: { createdAt: "asc" } });
  return rows.map((m) => {
    const b = (m.bankDetails ?? null) as Record<string, unknown> | null;
    const str = (k: string) => (b && typeof b[k] === "string" ? (b[k] as string) : "");
    const fee = [m.feePercent.gt(0) ? `${m.feePercent.toString()}%` : "", m.feeFixed.gt(0) ? m.feeFixed.toFixed(2) : ""].filter(Boolean).join(" + ");
    return {
      id: m.id,
      type: m.type,
      label: METHOD_LABEL[m.type] ?? m.type,
      min: m.minAmount.toFixed(2),
      max: m.maxAmount?.toFixed(2) ?? null,
      feeLine: fee || null,
      processing: m.processingTime,
      bank: m.type === "BANK_TRANSFER" && b ? { beneficiary: str("beneficiary"), bank: str("bank"), iban: str("iban"), swift: str("swift") } : null,
      wallet: m.type !== "BANK_TRANSFER" ? m.walletAddress : null,
      instructions: m.instructions,
    };
  });
}

/** DEP-<account>-<4 chars>: what the client writes on the transfer so the broker can match it. */
export function newPaymentReference(accountNumber: string): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(4);
  const tail = [...bytes].map((x) => alphabet[x % alphabet.length]).join("");
  return `DEP-${accountNumber}-${tail}`;
}
export function isPaymentReference(ref: unknown, accountNumber: string): ref is string {
  return typeof ref === "string" && new RegExp(`^DEP-${accountNumber}-[2-9A-HJ-NP-Z]{4}$`).test(ref);
}

/**
 * The most this account can withdraw now: never more than the balance (credit is not withdrawable), and never so much
 * that equity after the debit falls under the margin-call level of the open positions (the same rule the approval
 * runs, lib/margin.ts checkBalanceDebit). Pending withdrawals already requested are taken off.
 */
export async function withdrawable(accountId: string): Promise<{ available: string; currency: string }> {
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { leverage: true, balance: true, currency: true, brokerId: true, group: { select: { marginCallLevel: true } } } });
  const pending = await prisma.transaction.aggregate({ where: { accountId, type: "WITHDRAWAL", status: "PENDING" }, _sum: { amount: true } });
  const pendingAbs = (pending._sum.amount ?? new Prisma.Decimal(0)).abs();
  let cap = a.balance;
  const state = await loadAccountMarginState(prisma, accountId, a.leverage, [], a.brokerId).catch(() => null);
  if (!state) {
    const open = await prisma.position.count({ where: { accountId, status: "OPEN" } });
    if (open > 0) cap = new Prisma.Decimal(0); // cannot value the positions right now: nothing is shown as free
  } else if (state.usedMargin.gt(0)) {
    const mc = a.group?.marginCallLevel ?? new Prisma.Decimal(100);
    const marginRoom = state.equity.sub(state.usedMargin.mul(mc).div(100));
    if (marginRoom.lt(cap)) cap = marginRoom;
  }
  cap = cap.sub(pendingAbs);
  if (cap.lt(0)) cap = new Prisma.Decimal(0);
  return { available: cap.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN).toFixed(2), currency: a.currency };
}

export type RoomPayoutMethod = { id: string; type: PaymentMethodType; title: string; sub: string; verified: boolean };

export async function payoutMethods(clientId: string): Promise<RoomPayoutMethod[]> {
  const rows = await prisma.clientPayoutMethod.findMany({ where: { clientId, removedAt: null }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => {
    const d = (r.details ?? {}) as Record<string, string>;
    if (r.type === "BANK_TRANSFER") {
      return { id: r.id, type: r.type, title: `Bank account · ${d.bank ?? ""} ····${(d.account ?? "").replace(/\s+/g, "").slice(-4)}`, sub: r.holderName, verified: Boolean(r.verifiedAt) };
    }
    return { id: r.id, type: r.type, title: `${r.type === "BTC" ? "BTC" : r.type === "ETH" ? "ETH" : "USDT"} wallet · ${maskAddress(d.address)}`, sub: METHOD_LABEL[r.type].replace(/^USDT · /, ""), verified: Boolean(r.verifiedAt) };
  });
}

/** The destination text kept on the withdrawal row (what staff pay to). */
export function payoutDestination(r: { type: PaymentMethodType; holderName: string; details: Prisma.JsonValue }): string {
  const d = (r.details ?? {}) as Record<string, string>;
  return r.type === "BANK_TRANSFER" ? [r.holderName, d.bank, d.account, d.swift].filter(Boolean).join(" · ") : d.address ?? "";
}
