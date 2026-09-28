import { publishTradingEvent } from "@/lib/nats";

export type FundsRequestChange = "created" | "marked" | "unmarked" | "rejected" | "approved";

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
