import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { publishTradingEvent } from "@/lib/nats";

// AccountUpdated (2026-09-24): a backoffice change to what an account may do or how it is priced -- leverage,
// status, group, account type, swap-free, daily-loss limit, per-account / group / account-type pricing, group
// symbols, group halt. Before this, none of those routes published anything, so an open terminal / WebTrader kept
// the old leverage / spread / allowed symbols until something else made it refetch. Subject "account.updated"
// sits under the account.> wildcard both gateway streams already subscribe to (b26f797), forwarded per account_id.
// Clients refetch the account (and symbol specs) on it; the payload carries no values, only the reason.
export type AccountUpdatedReason =
  | "account"
  | "account_pricing"
  | "group"
  | "group_symbols"
  | "group_pricing"
  | "group_halt"
  | "account_type"
  | "account_type_pricing";

export async function publishAccountUpdated(brokerId: string, accountId: string, reason: AccountUpdatedReason): Promise<void> {
  await publishTradingEvent("AccountUpdated", { account_id: accountId, broker_id: brokerId, reason }).catch((err) =>
    console.error("[account-events] AccountUpdated publish failed", accountId, err)
  );
}

// Group / account-type edits touch every account on it. The fan-out runs after the response (next/server
// `after`), so a large group never slows the backoffice save; one event per account because the trader stream
// forwards by account_id, in small parallel batches (each publish is itself bounded to 2 s).
const FAN_OUT_BATCH = 20;

export async function fanOutAccountUpdated(
  brokerId: string,
  where: { groupId: string } | { accountTypeId: string },
  reason: AccountUpdatedReason
): Promise<number> {
  const accounts = await prisma.account.findMany({ where: { brokerId, ...where }, select: { id: true } });
  for (let i = 0; i < accounts.length; i += FAN_OUT_BATCH) {
    await Promise.all(accounts.slice(i, i + FAN_OUT_BATCH).map((a) => publishAccountUpdated(brokerId, a.id, reason)));
  }
  return accounts.length;
}

export function publishAccountsUpdatedAfterResponse(
  brokerId: string,
  where: { groupId: string } | { accountTypeId: string },
  reason: AccountUpdatedReason
): void {
  const task = () =>
    fanOutAccountUpdated(brokerId, where, reason).then(
      () => undefined,
      (err) => console.error("[account-events] AccountUpdated fan-out failed", where, err)
    );
  try {
    after(task);
  } catch {
    // Outside a request scope (tests, scripts): run it now instead.
    void task();
  }
}
