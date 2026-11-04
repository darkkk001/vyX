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
  "MIRROR_MANAGE",
  // owner decisions 2026-09-25 (audit Batch 4, lines 16 / 20)
  "PRICING",
  "CLIENT_TRADING",
  "DEALING",
  // owner 2026-10-29 (super-admin batch k1, web security batch 1 S1-S2; backoffice item 10 / 15)
  "REPORTS",
  "GROUPS_SYMBOLS",
  "STAFF_MANAGE",
  "CLIENT_PASSWORD_RESET",
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
  MIRROR_MANAGE: "Reverse mirror rules (create/edit/kill switch)",
  PRICING: "Can edit pricing (spread, commission, swap, hedged margin)",
  CLIENT_TRADING: "Can trade on client accounts (close, bulk close, SL/TP, open for a client)",
  DEALING: "Dealing (accept / offer new price / reject dealer orders, hedge orders)",
  REPORTS: "Reports (reports, statements, exports)",
  GROUPS_SYMBOLS: "Edit groups / symbols",
  STAFF_MANAGE: "Manage staff",
  CLIENT_PASSWORD_RESET: "Reset client passwords",
};

/** The Staff page / Assign checklist (owner 2026-10-29): this list, these labels, this order, in the Super Admin dialog and the backoffice
 *  Staff page alike (GET /api/manage/permissions). Keys not in it (RISK_SETTINGS, EMERGENCY_CONTROLS, ...) keep their own places. */
export const STAFF_CHECKLIST: readonly { key: Permission; label: string }[] = [
  { key: "CLIENT_TRADING", label: "Client trading" },
  { key: "FUNDS_APPROVAL", label: "Approve deposits / withdrawals" },
  { key: "KYC_REVIEW", label: "KYC" },
  { key: "DEALING", label: "Dealing desk" },
  { key: "REPORTS", label: "Reports" },
  { key: "GROUPS_SYMBOLS", label: "Edit groups / symbols" },
  { key: "STAFF_MANAGE", label: "Manage staff" },
  { key: "CLIENT_PASSWORD_RESET", label: "Reset client passwords" },
];
