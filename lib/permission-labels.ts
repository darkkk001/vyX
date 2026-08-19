// Client-safe constants split out of lib/permissions.ts (which has
// `server-only` + a Prisma import, so can't be imported from a "use
// client" component like TeamManager.tsx). Delegatable BROKER_ADMIN-only
// capabilities -- small, fixed list, not a join table, since this isn't
// an open-ended permission system (see docs/authentication.md's own
// RBAC-gap note: "permissions, not more role names"). Team/staff
// management and System Settings are deliberately NOT in this list --
// granting either would let a delegated Manager create more admins or
// change platform defaults, a materially different risk class than the
// operational actions below.
export const PERMISSIONS = [
  "KYC_REVIEW",
  "RISK_SETTINGS",
  "EMERGENCY_CONTROLS",
  "INTERNAL_TRANSFERS",
  "FUNDS_APPROVAL",
  "IB_PAYOUTS",
  "ACCOUNT_FINANCE",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  KYC_REVIEW: "KYC review",
  RISK_SETTINGS: "Risk settings",
  EMERGENCY_CONTROLS: "Emergency controls",
  INTERNAL_TRANSFERS: "Internal transfers",
  FUNDS_APPROVAL: "Funds approval",
  IB_PAYOUTS: "IB payouts",
  ACCOUNT_FINANCE: "Account finance (add/adjust/leverage/status)",
};
