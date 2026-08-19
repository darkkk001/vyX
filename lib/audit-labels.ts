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
  MANUAL_POSITION_REVERSE: "Reversed position",
  MANUAL_POSITION_VOID: "Voided erroneous position",
  ACCOUNT_GROUP_CHANGED: "Changed account group",
  LEVERAGE_CHANGE: "Changed leverage",
  ACCOUNT_STATUS_CHANGED: "Changed account status",
  ACCOUNT_MAX_DAILY_LOSS_CHANGED: "Changed max daily loss",
  GROUP_CREATED: "Created group",
  GROUP_CONFIG_UPDATED: "Updated group config",
  BROKER_CREATED: "Registered broker",
  BROKER_STATUS_CHANGED: "Changed broker status",
  SYMBOL_CONFIG_UPDATED: "Updated symbol config",
  BROKER_EXECUTION_ENGINE_CHANGED: "Changed execution engine",
  BALANCE_ADJUSTMENT: "Adjusted balance",
  MANUAL_POSITION_OPEN: "Opened manual position",
  MANUAL_POSITION_CLOSE: "Closed manual position",
  POSITION_SLTP_MODIFIED: "Modified position SL/TP",
  IB_RELATIONSHIP_CREATED: "Created IB relationship",
  IB_COMMISSION_PAID: "Paid IB commission",
  IB_RELATIONSHIP_UPDATED: "Updated IB relationship",
  FUNDS_REQUEST_REJECTED: "Rejected funds request",
  FUNDS_REQUEST_APPROVED: "Approved funds request",
  KYC_APPROVAL: "Approved KYC",
  KYC_REJECTION: "Rejected KYC",
  RISK_HALT_TOGGLED: "Toggled trading halt",
  RISK_LIMITS_UPDATED: "Updated risk limits",
  DEALING_MODE_TOGGLED: "Toggled dealing mode",
  DEALING_ORDER_ACCEPTED: "Accepted dealing order",
  DEALING_ORDER_REJECTED: "Rejected dealing order",
  INTERNAL_TRANSFER: "Internal transfer",
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
