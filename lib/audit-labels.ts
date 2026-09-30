import type { Prisma } from "@prisma/client";

// Broker-scoped audit views (Manager audit log, dashboard recent-activity
// widget, per-account activity timeline) should only show what that
// broker's own staff did. SUPER_ADMIN actions taken on a broker's behalf
// (password resets, SSO secret rotation, broker status/engine/logo
// changes, ...) carry that broker's brokerId too -- so Super Admin's own
// cross-tenant audit page can group by tenant -- but they aren't "this
// broker's staff" activity and shouldn't leak into a broker-scoped view.
// Spread alongside `brokerId` (and any other filter) in a `where` clause.
// Keeps system-generated rows, which have no actor at all.
export const excludeSuperAdminActor: Prisma.AuditLogWhereInput = {
  OR: [{ actorAdminId: null }, { actorAdmin: { role: { not: "SUPER_ADMIN" } } }],
};

// Humanized labels for AuditLog.action -- every value currently written
// anywhere in the app (grepped across app/api/manage and app/api/admin),
// plus the two this restyle pass adds (POSITION_SLTP_MODIFIED,
// BROKER_STATUS_CHANGED). Falls back to a title-cased raw string for any
// future action not listed here, so a missing entry never breaks the page.
const LABELS: Record<string, string> = {
  ADMIN_USER_CREATED: "Created admin user",
  ACCOUNT_CREATED: "Created account",
  ADMIN_USER_STATUS_CHANGED: "Changed admin status",
  PERMISSIONS_CHANGED: "Changed delegated permissions",
  LP_CREATED: "Added liquidity provider",
  LP_STATUS_CHANGED: "Changed liquidity provider status",
  FUNDS_REQUEST_MARKED_FOR_APPROVAL: "Marked withdrawal for approval",
  FUNDS_REQUEST_MARK_CANCELLED: "Cancelled withdrawal mark",
  MANUAL_POSITION_REVERSE: "Reversed position (close & reopen)",
  MANUAL_POSITION_VOID: "Voided position",
  POSITION_REVERSED_IN_PLACE: "Reversed position (in-place flip)",
  POSITION_DELETED: "Deleted position",
  POSITION_ACTION_REQUESTED: "Requested position action (pending approval)",
  POSITION_ACTION_APPROVED: "Approved position action",
  POSITION_ACTION_REJECTED: "Rejected position action",
  ACCOUNT_GROUP_CHANGED: "Changed account group",
  LEVERAGE_CHANGE: "Changed leverage",
  ACCOUNT_STATUS_CHANGED: "Changed account status",
  ACCOUNT_MAX_DAILY_LOSS_CHANGED: "Changed max daily loss",
  // AccountType (pricing tier -- Standard/Pro/Zero) scaffold.
  ACCOUNT_TYPE_CREATED: "Created account type",
  ACCOUNT_TYPE_UPDATED: "Updated account type",
  ACCOUNT_TYPE_CHANGED: "Changed account type",
  GROUP_CREATED: "Created group",
  GROUP_CONFIG_UPDATED: "Updated group config",
  GROUP_SYMBOLS_UPDATED: "Updated group symbol allowlist",
  GROUP_DELETED: "Deleted group",
  ACCOUNT_SWAP_FREE_CHANGED: "Changed account swap-free override",
  NEGATIVE_BALANCE_PROTECTION_APPLIED: "Negative-balance protection applied (broker absorbed loss)",
  BROKER_CREATED: "Registered broker",
  BROKER_STATUS_CHANGED: "Changed broker status",
  SYMBOL_CONFIG_UPDATED: "Updated symbol config",
  BROKER_EXECUTION_ENGINE_CHANGED: "Changed execution engine",
  BROKER_SUPPORT_EMAIL_CHANGED: "Changed WebTrader support email",
  BROKER_LOGO_CHANGED: "Changed broker logo",
  BROKER_PRIMARY_COLOR_CHANGED: "Changed broker primary color",
  BROKER_SSO_SECRET_GENERATED: "Generated WebTrader SSO secret",
  BROKER_SSO_SECRET_ROTATED: "Rotated WebTrader SSO secret",
  BROKER_SSO_SECRET_REVOKED: "Revoked WebTrader SSO secret",
  WEBTRADER_SSO_LOGIN: "Logged in via broker SSO handoff",
  WEBTRADER_ACCOUNT_SWITCH: "Switched WebTrader account",
  WEBTRADER_2FA_ENABLED: "Enabled two-factor authentication",
  WEBTRADER_2FA_DISABLED: "Disabled two-factor authentication",
  // Renamed from SUPER_ADMIN_2FA_{ENABLED,DISABLED} -- Phase 1 trust pack
  // widened app/api/admin/two-factor/* to every admin role, not just
  // Super Admin, so the action name shouldn't claim otherwise.
  ADMIN_2FA_ENABLED: "Enabled two-factor authentication",
  ADMIN_2FA_DISABLED: "Disabled two-factor authentication",
  ACCOUNT_PASSWORD_RESET: "Reset trader password",
  ADMIN_PASSWORD_RESET_BY_SUPER_ADMIN: "Reset backoffice staff password",
  WEBTRADER_SESSION_REVOKED: "Revoked WebTrader session",
  STM_HOTKEY_ORDER: "Placed order via Smart Trade Manager hotkey",
  // Broker feedback items 14+15 -- order-lifecycle events that previously
  // wrote no AuditLog row at all (plain placement, entry/SL/TP edits, the
  // common trigger->fill path) now do; these are their labels.
  ORDER_PLACED: "Placed order",
  ORDER_MODIFIED: "Modified order",
  ORDER_FILLED: "Filled order",
  ORDER_TRIGGERED_AND_FILLED: "Pending order triggered and filled",
  TRADER_CANCELLED_DEALING_ORDER: "Client cancelled order (awaiting dealer)",
  TRADER_CANCELLED_PENDING_ORDER: "Client cancelled pending order",
  DEALER_CANCELLED_PENDING_ORDER: "Dealer cancelled pending order",
  STM_BULK_CLOSE: "Closed positions via Smart Trade Manager bulk action",
  BALANCE_ADJUSTMENT: "Adjusted balance",
  BALANCE_ADJUSTMENT_REQUESTED: "Requested balance adjustment (pending approval)",
  BALANCE_ADJUSTMENT_APPROVED: "Approved balance adjustment",
  BALANCE_ADJUSTMENT_REJECTED: "Rejected balance adjustment",
  MANUAL_POSITION_OPEN: "Opened manual position",
  MANUAL_POSITION_CLOSE: "Closed manual position",
  MANUAL_POSITION_BULK_CLOSE: "Bulk-closed positions for account",
  POSITION_SLTP_MODIFIED: "Modified position SL/TP",
  IB_RELATIONSHIP_CREATED: "Created IB relationship",
  IB_COMMISSION_PAID: "Paid IB commission",
  IB_RELATIONSHIP_UPDATED: "Updated IB relationship",
  FUNDS_REQUEST_REJECTED: "Rejected funds request",
  FUNDS_REQUEST_APPROVED: "Approved funds request",
  KYC_APPROVAL: "Approved KYC",
  KYC_REJECTION: "Rejected KYC",
  CLIENT_KYC_APPROVAL: "Approved client KYC",
  CLIENT_KYC_REJECTION: "Rejected client KYC",
  CLIENT_PROFILE_UPDATED: "Client updated their profile",
  CLIENT_PASSWORD_CHANGED: "Client changed their password",
  LEAD_CREATED: "Created lead",
  LEAD_UPDATED: "Updated lead",
  LEAD_CONVERTED: "Converted lead",
  GROUP_LEVERAGE_APPLIED: "Applied group leverage to its accounts",
  COVERAGE_ACCOUNT_SET: "Set the dealer coverage account",
  LIVE_ACCOUNT_REQUEST_APPROVED: "Approved live account request",
  LIVE_ACCOUNT_REQUEST_REJECTED: "Rejected live account request",
  RISK_HALT_TOGGLED: "Toggled trading halt",
  RISK_LIMITS_UPDATED: "Updated risk limits",
  DEALING_MODE_TOGGLED: "Toggled dealing mode",
  DEALING_ORDER_ACCEPTED: "Accepted dealing order",
  DEALING_ORDER_REJECTED: "Rejected dealing order",
  DEALING_ORDER_REQUOTED: "Requoted dealing order",
  DEALING_ORDER_REQUOTE_ACCEPTED: "Client accepted requote",
  DEALING_ORDER_REQUOTE_REJECTED: "Client rejected requote",
  DEALING_ORDER_AUTO_ACCEPTED: "Smart Dealer auto-accepted order",
  PENDING_ORDER_QUEUED_FOR_DEALING: "Triggered pending order queued for dealing",
  DEALING_ORDER_AUTO_REJECTED: "Smart Dealer auto-rejected order",
  GATEWAY_ORDER_PLACED: "Placed order (Gateway)",
  GATEWAY_PENDING_ORDER_PLACED: "Placed pending order (Gateway)",
  GATEWAY_ORDER_CANCELLED: "Cancelled order (Gateway)",
  GATEWAY_POSITION_MODIFIED: "Modified position SL/TP (Gateway)",
  INTERNAL_TRANSFER: "Internal transfer",
  MIRROR_RULE_CREATED: "Created mirror rule",
  MIRROR_RULE_UPDATED: "Updated mirror rule",
  MIRROR_FILLED: "Mirrored fill",
  MIRROR_CLOSED: "Mirrored close",
  MIRROR_FAILED: "Mirror order failed",
  MIRROR_SKIPPED_RULE_DISABLED: "Mirror skipped: rule disabled",
  MIRROR_KILL_SWITCH: "Mirror rule kill switch triggered",
  SWAP_ROLLOVER_RUN: "Ran daily swap rollover",
  // Step 2 (owner 2026-09-30)
  ACCOUNT_SESSIONS_REVOKED: "Signed the client out everywhere",
  ACCOUNT_2FA_RESET: "Reset client two-step sign-in",
  ADMIN_2FA_RESET: "Reset staff two-step sign-in",
  ADMIN_SESSIONS_REVOKED: "Signed the staff member out everywhere",
  BROKER_CLIENT_SESSIONS_REVOKED: "Signed out all clients",
  MIRROR_RULE_DELETED: "Deleted copy rule",
  LP_DELETED: "Deleted liquidity provider",
  LEAD_ASSIGNED: "Assigned lead to staff",
  IB_PARTNER_SUSPENDED: "Suspended partner (pay frozen)",
  IB_PARTNER_RESUMED: "Resumed partner",
  IB_PARTNER_OWED_RELEASED: "Released frozen partner pay",
  IB_FROZEN_PAY_RELEASED: "Paid frozen partner pay",
};

export function humanizeAction(action: string): string {
  return (
    LABELS[action] ??
    action
      .toLowerCase()
      .split("_")
      .map((w) => w[0]?.toUpperCase() + w.slice(1))
      .join(" ")
  );
}

// Where double-clicking an audit log row (app/manage/(shell)/audit) should
// send a manager -- "take me to that action." Account is the only entity
// with a real per-id detail page (app/manage/accounts/[id]); everything
// else routes to its list page, which is still more useful than nowhere.
// Returns null for an entityType with no known destination -- that row
// just isn't clickable rather than linking somewhere wrong.
const ENTITY_LIST_PATHS: Record<string, string> = {
  AdminUser: "/manage/team",
  LiquidityProvider: "/manage/liquidity",
  Broker: "/manage/settings",
  KycRecord: "/manage/kyc",
  Order: "/manage/dealing",
  Position: "/manage/positions",
  Group: "/manage/groups",
  Lead: "/manage/leads",
  IbRelationship: "/manage/ib",
  BrokerSymbol: "/manage/symbols",
  Transaction: "/manage/funds",
  AccountType: "/manage/settings",
};

export function auditEntityHref(entityType: string, entityId: string): string | null {
  if (entityType === "Account") return `/manage/accounts/${entityId}`;
  return ENTITY_LIST_PATHS[entityType] ?? null;
}

function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Broker feedback items 14+15 -- order/position lifecycle AuditLog rows
// (see lib/order-audit.ts's orderAuditFields) carry these same identity
// fields in every event, on purpose, so any single row is self-contained.
// That's exactly what makes them wrong to run through the change-diff
// below: they're identical between oldValue/newValue by design (an
// order's symbol doesn't change), so the diff's own dedup would silently
// drop them, and where only one side carries them (e.g. a fill's oldValue
// snapshot) they'd wrongly render as "(removed)". Surfaced instead as
// their own dedicated column via extractOrderIdentity.
const ORDER_IDENTITY_FIELDS = new Set(["orderNumber", "accountNumber", "symbol", "side", "type", "lots"]);

export type OrderAuditIdentity = {
  orderNumber: string;
  ticket: number | null;
  accountNumber: string | null;
  symbol: string | null;
  side: string | null;
  lots: string | null;
};

// Reads whichever of oldValue/newValue actually carries the order's
// identity fields (placement only ever has newValue; a cancellation has
// both) -- returns null for any AuditLog row that isn't an order/position
// lifecycle event at all (nothing in this app writes an `orderNumber` key
// for anything else).
export function extractOrderIdentity(oldValue: Prisma.JsonValue | null, newValue: Prisma.JsonValue | null): OrderAuditIdentity | null {
  const asPlainObject = (v: Prisma.JsonValue | null): Record<string, unknown> | null =>
    v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const before = asPlainObject(oldValue) ?? {};
  const after = asPlainObject(newValue) ?? {};
  const orderNumber = after.orderNumber ?? before.orderNumber;
  if (typeof orderNumber !== "string") return null;
  const pick = (key: string): string | null => {
    const v = after[key] ?? before[key];
    return typeof v === "string" ? v : null;
  };
  const ticketRaw = after.ticket ?? before.ticket;
  return {
    orderNumber,
    ticket: typeof ticketRaw === "number" ? ticketRaw : null,
    accountNumber: pick("accountNumber"),
    symbol: pick("symbol"),
    side: pick("side"),
    lots: pick("lots"),
  };
}

// The audit log has always recorded AuditLog.oldValue/newValue, but every
// consumer (Manager and Super Admin's audit pages alike) only ever showed
// actor/action/target/time -- the actual before/after was captured on
// every write and then never surfaced anywhere. Computed server-side, not
// client-side, same "pre-humanize before it crosses the wire" convention
// as humanizeAction and the dashboard's own activity feed -- both audit
// routes call this once per row instead of shipping raw JSON for two
// separate client components to each re-parse the same way.
export function summarizeAuditDiff(oldValue: Prisma.JsonValue | null, newValue: Prisma.JsonValue | null): string[] {
  const asPlainObject = (v: Prisma.JsonValue | null): Record<string, unknown> | null =>
    v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

  const before = asPlainObject(oldValue);
  const after = asPlainObject(newValue);
  if (!before && !after) return [];
  if (!before) return Object.entries(after!).map(([key, value]) => `${key}: ${formatDiffValue(value)}`);
  if (!after) return Object.entries(before).map(([key, value]) => `${key}: ${formatDiffValue(value)} (removed)`);

  const lines: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ORDER_IDENTITY_FIELDS.has(key)) continue;
    const beforeValue = before[key];
    const afterValue = after[key];
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
    if (beforeValue === undefined) lines.push(`${key}: ${formatDiffValue(afterValue)}`);
    else if (afterValue === undefined) lines.push(`${key}: ${formatDiffValue(beforeValue)} (removed)`);
    else lines.push(`${key}: ${formatDiffValue(beforeValue)} → ${formatDiffValue(afterValue)}`);
  }
  return lines;
}

// Step 2 (owner 2026-09-30): who a row came from, so AUD / DASH never have to guess from actorEmail "system".
//   STAFF   = a staff member (actorAdminId set)
//   DIRECT  = a direct, owner-approved database change: no staff member and a newValue.source text (e.g. the
//             2026-09-30 swap-free cleanup, 15 rows)
//   CLIENT  = the client did it from the trading app or client portal. Only the actions written by app/api/trade/**
//             and app/api/portal/** with no staff member (every writer checked 2026-09-30); POSITION_CLOSED is NOT in
//             the list because the same action is also written by stop-outs / SL / TP (lib/post-close.ts).
//   SYSTEM  = everything else with no staff member (engine fills, stop-outs, scheduled jobs)
export type AuditActorKind = "STAFF" | "SYSTEM" | "CLIENT" | "DIRECT";
const CLIENT_ACTIONS = new Set([
  "ORDER_PLACED",
  "ORDER_MODIFIED",
  "ORDER_CANCELLED",
  "TRADER_CANCELLED_PENDING_ORDER",
  "STM_BULK_CLOSE",
  "STM_HOTKEY_ORDER",
  "WEBTRADER_SESSION_REVOKED",
  "DEALING_ORDER_REQUOTE_ACCEPTED",
  "DEALING_ORDER_REQUOTE_REJECTED",
  "DEALING_CLOSE_REQUOTE_ACCEPTED",
  "CLIENT_PROFILE_UPDATED",
  "CLIENT_PASSWORD_CHANGED",
]);

export function auditSource(newValue: Prisma.JsonValue | null): string | null {
  if (newValue && typeof newValue === "object" && !Array.isArray(newValue)) {
    const v = (newValue as Record<string, unknown>).source;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function auditActorKind(row: { actorAdminId: string | null; action: string; newValue: Prisma.JsonValue | null }): AuditActorKind {
  if (row.actorAdminId) return "STAFF";
  if (auditSource(row.newValue)) return "DIRECT";
  if (CLIENT_ACTIONS.has(row.action)) return "CLIENT";
  return "SYSTEM";
}
