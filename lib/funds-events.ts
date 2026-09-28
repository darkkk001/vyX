import { publishTradingEvent } from "@/lib/nats";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";

export type FundsRequestChange = "created" | "marked" | "unmarked" | "rejected" | "approved";

// Phase 2 batch 8 (issue 112): the trader hears the outcome of their own request -- an event to their terminal /
// WebTrader (toast) and a notification row on their account (history). Never fails the caller.
export async function notifyFundsRequestResolved(args: {
  brokerId: string;
  accountId: string;
  transactionId: string;
  kind: "DEPOSIT" | "WITHDRAWAL";
  outcome: "APPROVED" | "REJECTED";
  amount: string;
  reviewNote: string | null;
}): Promise<void> {
  const what = args.kind === "DEPOSIT" ? "deposit" : "withdrawal";
  const title = `Your ${what} of ${args.amount} was ${args.outcome === "APPROVED" ? "approved" : "rejected"}`;
  const body = args.reviewNote ? `${title}: ${args.reviewNote}` : title;
  await createNotification(prisma, {
    brokerId: args.brokerId,
    accountId: args.accountId,
    type: args.outcome === "APPROVED" ? "FUNDS_REQUEST_APPROVED" : "FUNDS_REQUEST_REJECTED",
    title,
    body,
    entityType: "Transaction",
    entityId: args.transactionId,
  }).catch((err) => console.error("[funds-events] trader notification failed", err));
  await publishTradingEvent("FundsRequestResolved", {
    broker_id: args.brokerId,
    account_id: args.accountId,
    transaction_id: args.transactionId,
    kind: args.kind,
    outcome: args.outcome,
    amount: args.amount,
    review_note: args.reviewNote ?? "",
    message: body,
  }).catch((err) => console.error("[funds-events] FundsRequestResolved publish failed", err));
}

// Phase 2 batch 7 (issue 298): tell the broker's backoffice that a funds request changed, so the funds queue and the
// dashboard's approvals tile refresh at once (subject dealing.funds_request: admin stream only, never a trader's).
// Never fails the caller: the request itself is already committed.
export async function publishFundsRequestChanged(args: {
  brokerId: string;
  accountId: string;
  transactionId: string;
  change: FundsRequestChange;
}): Promise<void> {
  await publishTradingEvent("FundsRequestChanged", {
    broker_id: args.brokerId,
    account_id: args.accountId,
    transaction_id: args.transactionId,
    change: args.change,
  }).catch((err) => console.error("[funds-events] FundsRequestChanged publish failed", err));
}
