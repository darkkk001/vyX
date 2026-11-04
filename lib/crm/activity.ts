import type { Prisma } from "@prisma/client";
import { humanizeAction } from "@/lib/audit-labels";

// One line per audit row for the client 360 activity feed. The common client events read as sentences; anything else
// is the platform's own humanized action name, with the account when there is one.
const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
};

export function auditLabel(action: string, newValue: Prisma.JsonValue | null, accountNumber: string | null): string {
  const v = (newValue ?? {}) as Record<string, unknown>;
  const on = accountNumber ? ` on ${accountNumber}` : v.accountNumber ? ` on ${v.accountNumber}` : "";
  switch (action) {
    case "DEPOSIT_REQUESTED": return `Deposit of ${money(v.amount)} requested${on}.`;
    case "WITHDRAWAL_REQUESTED": return `Withdrawal of ${money(v.amount)} requested${on}.`;
    case "FUNDS_REQUEST_APPROVED": return `Funds request approved${on}.`;
    case "FUNDS_REQUEST_REJECTED": return `Funds request rejected${on}.`;
    case "LEVERAGE_CHANGE": return `Leverage set to 1:${v.leverage}${on}.`;
    case "LEVERAGE_CHANGE_REQUESTED": return `Leverage 1:${v.leverage} requested${on}.`;
    case "ACCOUNT_CREATED": return `Account ${v.accountNumber ?? ""} opened (${String(v.accountMode ?? "").toLowerCase()}).`;
    case "LIVE_ACCOUNT_REQUESTED": return `Live account requested${v.plan ? ` (${v.plan})` : ""}.`;
    case "SUPPORT_TICKET_OPENED": return `Support ticket opened: ${v.subject ?? ""}`;
    case "CLIENT_PASSWORD_CHANGED": return "Password changed.";
    case "CLIENT_2FA_ENABLED": return "2FA turned on.";
    case "CLIENT_2FA_DISABLED": return "2FA turned off.";
    case "INTERNAL_TRANSFER": return `Transfer ${v.fromAccount ?? ""} to ${v.toAccount ?? ""}: ${money(v.amount)}.`;
    case "PAYOUT_METHOD_ADDED": return "Payout method added.";
    case "LEAD_CONVERTED": return "Converted from a lead.";
    case "IB_PAYOUT_REQUESTED": return `Partner payout of ${money(v.amount)} requested.`;
    default: return `${humanizeAction(action)}${on}`;
  }
}
