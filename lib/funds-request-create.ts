import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { resolvePspAdapter } from "@/lib/psp/adapter";
import { publishFundsRequestChanged, notifyFundsRequestResolved } from "@/lib/funds-events";
import { approveFundsRequest } from "@/lib/funds-approval";
import { publishTradingEvent } from "@/lib/nats";
import { withdrawalKycApproved, WITHDRAWAL_KYC_CODE, WITHDRAWAL_KYC_MESSAGE } from "@/lib/withdrawal-kyc";

// One deposit / withdrawal request path for every client surface: the terminal (POST /api/trade/funds-requests,
// account session) and the Trader's Room (client session, lib/room). Moved here unchanged from the trade route
// (2026-11-03); the room adds a payment reference, a saved payout method and its own free-margin cap, all optional.

export type FundsRequestInput = {
  brokerId: string;
  accountId: string;
  type: "DEPOSIT" | "WITHDRAWAL";
  amount: unknown;
  paymentMethodId: unknown;
  destinationAddress?: unknown;
  receiptDataUrl?: unknown;
  note?: unknown;
  pspAdapter?: unknown;
  paymentReference?: string | null;
  payoutMethodId?: string | null;
};

export type FundsRequestResult =
  | { ok: true; created: { id: string; type: string; status: string; amount: string; pspStatus: string | null; pspReference: string | null } }
  | { ok: false; status: number; error: string; code?: string };

const fail = (status: number, error: string, code?: string): FundsRequestResult => ({ ok: false, status, error, ...(code ? { code } : {}) });

export async function createFundsRequest(p: FundsRequestInput): Promise<FundsRequestResult> {
  let requestedAmount: Prisma.Decimal;
  try {
    requestedAmount = new Prisma.Decimal(String(p.amount ?? ""));
  } catch {
    return fail(400, "invalid amount");
  }
  if (!requestedAmount.gt(0)) return fail(400, "amount must be positive");

  const account = await prisma.account.findUniqueOrThrow({ where: { id: p.accountId } });
  if (account.status !== "ACTIVE") return fail(400, "account is not active");

  // Withdrawals need approved KYC (lib/withdrawal-kyc.ts): the account's own record, or its client's.
  if (p.type === "WITHDRAWAL" && !(await withdrawalKycApproved(prisma, p.accountId))) {
    return fail(403, WITHDRAWAL_KYC_MESSAGE, WITHDRAWAL_KYC_CODE);
  }

  const paymentMethodId = typeof p.paymentMethodId === "string" ? p.paymentMethodId : null;
  if (!paymentMethodId) return fail(400, "paymentMethodId is required");
  const paymentMethod = await prisma.paymentMethod.findUnique({ where: { id: paymentMethodId } });
  if (!paymentMethod || paymentMethod.brokerId !== p.brokerId || !paymentMethod.enabled) return fail(400, "unknown or disabled payment method");
  // a withdrawal has its own limits when the broker set them
  const minAmount = p.type === "WITHDRAWAL" ? paymentMethod.withdrawMinAmount ?? paymentMethod.minAmount : paymentMethod.minAmount;
  const maxAmount = p.type === "WITHDRAWAL" ? paymentMethod.withdrawMaxAmount ?? paymentMethod.maxAmount : paymentMethod.maxAmount;
  if (requestedAmount.lt(minAmount)) return fail(400, `amount is below this method's minimum of ${minAmount.toString()}`);
  if (maxAmount && requestedAmount.gt(maxAmount)) return fail(400, `amount is above this method's maximum of ${maxAmount.toString()}`);

  const destinationAddress = typeof p.destinationAddress === "string" ? p.destinationAddress.trim().slice(0, 500) : null;
  if (p.type === "WITHDRAWAL" && !destinationAddress) return fail(400, "destinationAddress is required for a withdrawal");

  const receiptDataUrl = typeof p.receiptDataUrl === "string" && p.receiptDataUrl.startsWith("data:") ? p.receiptDataUrl : null;
  const amount = p.type === "WITHDRAWAL" ? requestedAmount.negated() : requestedAmount;
  if (p.type === "WITHDRAWAL" && requestedAmount.gt(account.balance)) return fail(400, "withdrawal amount exceeds available balance");

  const note = typeof p.note === "string" ? p.note.trim().slice(0, 500) : null;
  const adapter = resolvePspAdapter(p.pspAdapter);
  const pspResult =
    p.type === "DEPOSIT"
      ? adapter.requestDeposit({ amount: requestedAmount, methodType: paymentMethod.type })
      : adapter.requestWithdrawal({ amount: requestedAmount, methodType: paymentMethod.type, destinationAddress: destinationAddress! });

  const created = await prisma.transaction.create({
    data: {
      brokerId: p.brokerId,
      accountId: p.accountId,
      type: p.type,
      status: "PENDING",
      amount,
      balanceBefore: account.balance,
      balanceAfter: account.balance,
      note,
      paymentMethodId: paymentMethod.id,
      pspAdapter: adapter.kind,
      pspStatus: pspResult.pspStatus,
      pspReference: pspResult.pspReference,
      confirmations: "confirmations" in pspResult ? pspResult.confirmations : null,
      destinationAddress,
      receiptDataUrl,
      paymentReference: p.paymentReference ?? null,
      payoutMethodId: p.payoutMethodId ?? null,
    },
  });

  await createNotification(prisma, {
    brokerId: p.brokerId,
    type: "FUNDS_REQUEST",
    title: `New ${p.type.toLowerCase()} request`,
    body: `${account.accountNumber} requested ${requestedAmount.toString()}${note ? ` (${note})` : ""}`,
    entityType: "Transaction",
    entityId: created.id,
  });
  await publishFundsRequestChanged({ brokerId: p.brokerId, accountId: p.accountId, transactionId: created.id, change: "created" });

  // Auto-approval of small withdrawals (Broker.autoApproveWithdrawalMax): same approval path as staff, single mode.
  let status: string = created.status;
  if (p.type === "WITHDRAWAL") {
    const cfg = await prisma.broker.findUnique({ where: { id: p.brokerId }, select: { autoApproveWithdrawalMax: true } });
    const limit = cfg?.autoApproveWithdrawalMax;
    if (limit && requestedAmount.lte(limit)) {
      const done = await prisma
        .$transaction((tx) =>
          approveFundsRequest(tx, { transactionId: created.id, brokerId: p.brokerId, accountId: p.accountId, amount, adminId: null, note: null, type: "WITHDRAWAL", approvalMode: "SINGLE", auto: { limit: limit.toString() }, requireKyc: true })
        )
        .catch((err) => { console.error("[funds-requests] auto-approve failed, left pending", err); return null; });
      if (done?.ok) {
        status = "COMPLETED";
        await publishTradingEvent("BalanceChanged", { account_id: p.accountId, broker_id: p.brokerId, transaction_id: created.id }).catch(() => {});
        await publishFundsRequestChanged({ brokerId: p.brokerId, accountId: p.accountId, transactionId: created.id, change: "approved" });
        await notifyFundsRequestResolved({ brokerId: p.brokerId, accountId: p.accountId, transactionId: created.id, kind: "WITHDRAWAL", outcome: "APPROVED", amount: requestedAmount.toString(), reviewNote: null });
      }
    }
  }

  return { ok: true, created: { id: created.id, type: created.type, status, amount: created.amount.toString(), pspStatus: created.pspStatus, pspReference: created.pspReference } };
}
