import "server-only";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

// Provider-agnostic PSP adapter interface backing Transaction's own
// paymentMethodId/pspAdapter/pspStatus/pspReference/confirmations/
// destinationAddress fields (see that model's schema comment for the
// full field-by-field reasoning -- this file is what that comment
// points at). Scoped deliberately narrow: an adapter's only job is the
// REQUEST side -- generating a reference and an initial status the
// moment a trader submits a deposit/withdrawal. Everything downstream
// (admin maker-checker review, the actual balance movement) stays
// lib/funds-approval.ts's job, unchanged and adapter-agnostic -- see
// nextPspStatusOnMark/nextPspStatusOnApprove below, which that file
// calls directly rather than re-resolving an adapter instance.
//
// Two implementations exist, and only one is real:
//   - MANUAL: the only trader-facing adapter today. No payment gateway
//     integration exists (see CLAUDE.md's own "Known simplifications"),
//     so this never reports confirmations or payout progress on its
//     own -- it stops at PENDING/REQUESTED. An admin's own review is
//     what advances CREDITED/PAID, same as it already did before this
//     file existed.
//   - MOCK: dev/Playwright only, simulating an instantly-confirmed PSP
//     round trip so an automated test can assert the funds UI's status
//     timeline without a human clicking through backoffice review.
//     resolvePspAdapter refuses to hand this out in production
//     regardless of what a request asks for. It only ever touches
//     pspStatus/pspReference/confirmations (the informational timeline)
//     -- never `status`/balance, which stays admin-gated no matter which
//     adapter served the request, same as every other funds path in
//     this app.
export type PspAdapterKind = "MANUAL" | "MOCK";

// Deposit: PENDING -> CONFIRMING (crypto, once a real adapter can report
// on-chain confirmations) -> CREDITED.
export type DepositPspStatus = "PENDING" | "CONFIRMING" | "CREDITED";
// Withdrawal: REQUESTED -> APPROVED (first maker-checker mark) ->
// PROCESSING (once a real adapter can report payout-in-flight) -> PAID.
export type WithdrawalPspStatus = "REQUESTED" | "APPROVED" | "PROCESSING" | "PAID";

export type PspDepositRequestResult = {
  pspReference: string;
  pspStatus: DepositPspStatus;
  confirmations: number | null;
};
export type PspWithdrawalRequestResult = {
  pspReference: string;
  pspStatus: WithdrawalPspStatus;
};

export interface PspAdapter {
  readonly kind: PspAdapterKind;
  requestDeposit(input: { amount: Prisma.Decimal; methodType: string }): PspDepositRequestResult;
  requestWithdrawal(input: { amount: Prisma.Decimal; methodType: string; destinationAddress: string }): PspWithdrawalRequestResult;
}

function reference(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

export const manualPspAdapter: PspAdapter = {
  kind: "MANUAL",
  requestDeposit() {
    return { pspReference: reference("MAN"), pspStatus: "PENDING", confirmations: null };
  },
  requestWithdrawal() {
    return { pspReference: reference("MAN"), pspStatus: "REQUESTED" };
  },
};

export const mockPspAdapter: PspAdapter = {
  kind: "MOCK",
  requestDeposit() {
    return { pspReference: reference("MOCK"), pspStatus: "CREDITED", confirmations: 6 };
  },
  requestWithdrawal() {
    return { pspReference: reference("MOCK"), pspStatus: "PAID" };
  },
};

// `requested` comes straight off a request body -- MOCK is a real footgun
// if it ever reached production (it would show a trader "CREDITED"/"PAID"
// before any admin has actually reviewed anything, even though the real
// ledger-affecting `status` field is untouched). The NODE_ENV guard is
// what makes "MOCK... never chosen by a real trader-facing method" (the
// Transaction.pspAdapter schema comment's own words) actually true rather
// than just documented intent.
export function resolvePspAdapter(requested: unknown): PspAdapter {
  if (requested === "MOCK" && process.env.NODE_ENV !== "production") {
    return mockPspAdapter;
  }
  return manualPspAdapter;
}

// Called by lib/funds-approval.ts at each maker-checker transition to
// keep pspStatus's trader-facing timeline in sync with the real review
// state machine -- identical regardless of which adapter created the
// request, since by the time a human is reviewing it, "what actually
// happened" is the same fact either way.
export function nextPspStatusOnMark(): WithdrawalPspStatus {
  return "APPROVED";
}
export function nextPspStatusOnApprove(type: "DEPOSIT" | "WITHDRAWAL"): DepositPspStatus | WithdrawalPspStatus {
  return type === "DEPOSIT" ? "CREDITED" : "PAID";
}

// Display-only fee estimate (PaymentMethod.feePercent/feeFixed) -- shown
// to the trader before they submit and to the admin configuring a
// method, NOT deducted from Transaction.amount. Real fee deduction needs
// a decision this feature doesn't make on its own (does the trader eat
// it, does it come off the credited/paid amount, who absorbs rounding)
// -- deliberately deferred rather than guessed at, same as this file's
// own MANUAL-stops-at-PENDING boundary. Flagged, not hidden.
export function estimatePspFee(
  method: { feePercent: Prisma.Decimal | string; feeFixed: Prisma.Decimal | string },
  amount: Prisma.Decimal
): Prisma.Decimal {
  const percent = new Prisma.Decimal(method.feePercent);
  const fixed = new Prisma.Decimal(method.feeFixed);
  return amount.mul(percent).div(100).add(fixed);
}
