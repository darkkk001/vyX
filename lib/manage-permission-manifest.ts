// The hand-authored RBAC expectation for every /api/manage/* route (one row per
// distinct permission requirement in each route.ts, by direct reading -- see
// app/api/manage/permission-matrix.test.ts's header, which proves every row
// against the real handler). Split out of that test (Phase 2 batch 4) so
// lib/backoffice-screens.test.ts can check the backoffice menu against the
// SAME expectations -- the menu and the routes cannot drift apart.
//
// supportRead: the read-only SUPPORT role may also read this GET (owner
// decision 2026-09-26; lib/permissions.ts isSupportReader). Every other row --
// every write included -- must refuse SUPPORT.

export type PermKey =
  | "ANY_MANAGER"
  | "BROKER_ADMIN_ONLY"
  | "ANY_ADMIN"
  | "RISK_OR_EMERGENCY"
  | "KYC_REVIEW"
  | "RISK_SETTINGS"
  | "EMERGENCY_CONTROLS"
  | "ACCOUNT_FINANCE"
  | "FUNDS_APPROVAL"
  | "INTERNAL_TRANSFERS"
  | "IB_PAYOUTS"
  | "MIRROR_MANAGE"
  // Batch 4 owner decisions (2026-09-25)
  | "PRICING"
  | "CLIENT_TRADING"
  | "DEALING";

export type PersonaKey = "readonly" | "dealer" | "finance" | "support";

export const PERSONA_DEFS: Record<PersonaKey, { role: "MANAGER" | "SUPPORT"; extraPermissions: string[] }> = {
  readonly: { role: "MANAGER", extraPermissions: [] },
  dealer: { role: "MANAGER", extraPermissions: ["RISK_SETTINGS", "EMERGENCY_CONTROLS"] },
  finance: { role: "MANAGER", extraPermissions: ["ACCOUNT_FINANCE", "FUNDS_APPROVAL", "INTERNAL_TRANSFERS", "IB_PAYOUTS"] },
  support: { role: "SUPPORT", extraPermissions: [] },
};

export function expectedAllowed(perm: PermKey, persona: PersonaKey, supportRead = false): boolean {
  const def = PERSONA_DEFS[persona];
  if (def.role === "SUPPORT" && supportRead) return true;
  switch (perm) {
    case "ANY_MANAGER":
      return def.role === "MANAGER";
    case "BROKER_ADMIN_ONLY":
      return false; // none of the 4 personas is BROKER_ADMIN -- deliberate, see file header
    case "ANY_ADMIN":
      return true; // any signed-in admin, SUPPORT included (theme/route.ts)
    case "RISK_OR_EMERGENCY":
      return def.role === "MANAGER" && (def.extraPermissions.includes("RISK_SETTINGS") || def.extraPermissions.includes("EMERGENCY_CONTROLS"));
    default:
      return def.role === "MANAGER" && def.extraPermissions.includes(perm);
  }
}

export type Row = {
  mod: string; // relative to app/api/manage/
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  perm: PermKey;
  needsId?: boolean;
  body?: Record<string, unknown>;
  supportRead?: boolean;
};

export const FAKE_ID = "cnonexistenttestid00001";

// One row per DISTINCT permission requirement found in each route.ts
// (by direct reading -- see the file header). Ordered to match
// alphabetical file layout under app/api/manage/.
export const MANIFEST: Row[] = [
  { mod: "account-types/[id]/pricing/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "account-types/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "account-types/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "accounts/[id]/activity/route", method: "GET", perm: "ANY_MANAGER", needsId: true, supportRead: true },
  { mod: "accounts/[id]/adjust-balance/route", method: "POST", perm: "ACCOUNT_FINANCE", needsId: true, body: {} },
  { mod: "accounts/[id]/positions/route", method: "GET", perm: "ANY_MANAGER", needsId: true, supportRead: true },
  { mod: "accounts/[id]/equity-curve/route", method: "GET", perm: "ANY_MANAGER", needsId: true, supportRead: true },
  { mod: "accounts/[id]/kyc/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "accounts/[id]/pricing/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "accounts/[id]/reset-password/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "accounts/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "accounts/[id]/risk/route", method: "GET", perm: "ANY_MANAGER", needsId: true, supportRead: true },
  { mod: "accounts/[id]/security/route", method: "GET", perm: "ANY_MANAGER", needsId: true, supportRead: true },
  { mod: "accounts/route", method: "GET", perm: "ANY_MANAGER", supportRead: true },
  { mod: "admins/[id]/route", method: "PATCH", perm: "BROKER_ADMIN_ONLY", needsId: true, body: {} },
  { mod: "admins/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "admins/route", method: "POST", perm: "BROKER_ADMIN_ONLY", body: {} },
  // Phase 2 batch 4: broker-side staff password reset (temporary password shown once)
  { mod: "admins/[id]/reset-password/route", method: "POST", perm: "BROKER_ADMIN_ONLY", needsId: true, body: {} },
  { mod: "audit/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "balance-adjustment-requests/[id]/approve/route", method: "POST", perm: "ACCOUNT_FINANCE", needsId: true, body: {} },
  // reject needs the same authority as approve (audit 2026-09-24 line 19)
  { mod: "balance-adjustment-requests/[id]/reject/route", method: "POST", perm: "ACCOUNT_FINANCE", needsId: true, body: {} },
  { mod: "balance-adjustment-requests/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "client-kyc-requests/[id]/document/route", method: "GET", perm: "KYC_REVIEW", needsId: true, supportRead: true },
  { mod: "client-kyc-requests/[id]/route", method: "PATCH", perm: "KYC_REVIEW", needsId: true, body: {} },
  { mod: "client-kyc-requests/route", method: "GET", perm: "KYC_REVIEW", supportRead: true },
  { mod: "dashboard/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "dealing-desk-toggle/route", method: "GET", perm: "RISK_SETTINGS" },
  { mod: "dealing-desk/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "dealing-queue/[id]/route", method: "PATCH", perm: "DEALING", needsId: true, body: {} },
  { mod: "dealing-queue/route", method: "GET", perm: "ANY_MANAGER" },
  // Phase 2 batch 1: a dealer cancels a client's resting LIMIT/STOP order
  { mod: "orders/[id]/cancel/route", method: "POST", perm: "DEALING", needsId: true, body: {} },
  { mod: "deals/route", method: "GET", perm: "ANY_MANAGER", supportRead: true },
  { mod: "feed-health/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "funds-requests/[id]/route", method: "PATCH", perm: "FUNDS_APPROVAL", needsId: true, body: {} },
  { mod: "funds-requests/route", method: "GET", perm: "FUNDS_APPROVAL", supportRead: true },
  { mod: "groups/[id]/halt/route", method: "PATCH", perm: "EMERGENCY_CONTROLS", needsId: true, body: {} },
  { mod: "groups/[id]/pricing/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "groups/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "groups/[id]/route", method: "DELETE", perm: "BROKER_ADMIN_ONLY", needsId: true },
  { mod: "groups/[id]/symbols/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "groups/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "ib-relationships/[id]/route", method: "PATCH", perm: "IB_PAYOUTS", needsId: true, body: {} },
  { mod: "ib-relationships/route", method: "GET", perm: "IB_PAYOUTS" },
  { mod: "kyc-requests/[id]/document/route", method: "GET", perm: "KYC_REVIEW", needsId: true, supportRead: true },
  { mod: "kyc-requests/[id]/route", method: "PATCH", perm: "KYC_REVIEW", needsId: true, body: {} },
  { mod: "kyc-requests/route", method: "GET", perm: "KYC_REVIEW", supportRead: true },
  { mod: "leads/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "leads/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "liquidity-providers/[id]/route", method: "PATCH", perm: "BROKER_ADMIN_ONLY", needsId: true, body: {} },
  { mod: "liquidity-providers/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "liquidity/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "live-account-requests/[id]/route", method: "PATCH", perm: "KYC_REVIEW", needsId: true, body: {} },
  { mod: "live-account-requests/route", method: "GET", perm: "KYC_REVIEW" },
  { mod: "live-activity/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "lp-routing/[id]/route", method: "DELETE", perm: "BROKER_ADMIN_ONLY", needsId: true },
  { mod: "lp-routing/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "margin/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "mirror-rules/[id]/route", method: "GET", perm: "MIRROR_MANAGE", needsId: true },
  { mod: "mirror-rules/route", method: "GET", perm: "MIRROR_MANAGE" },
  { mod: "notifications/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "notifications/route", method: "GET", perm: "ANY_MANAGER", supportRead: true },
  // bulk mark-all-read is a (shared-state) write: SUPPORT stays refused
  { mod: "notifications/route", method: "PATCH", perm: "ANY_MANAGER", body: { markAllRead: true } },
  { mod: "order-latency/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "payment-methods/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "position-action-requests/[id]/approve/route", method: "POST", perm: "ACCOUNT_FINANCE", needsId: true, body: {} },
  { mod: "position-action-requests/[id]/reject/route", method: "POST", perm: "ACCOUNT_FINANCE", needsId: true, body: {} },
  { mod: "position-action-requests/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "positions/[id]/close/route", method: "POST", perm: "CLIENT_TRADING", needsId: true, body: {} },
  { mod: "positions/[id]/delete/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "positions/[id]/replay/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "positions/[id]/reverse/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "positions/[id]/route", method: "PATCH", perm: "CLIENT_TRADING", needsId: true, body: {} },
  { mod: "positions/[id]/void/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "positions/close-bulk/route", method: "POST", perm: "CLIENT_TRADING", body: {} },
  { mod: "positions/route", method: "GET", perm: "ANY_MANAGER", supportRead: true },
  { mod: "pricing-shadow-compare/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/client/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/financial/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/ib/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/lp/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "reports/risk/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/summary/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/trading/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "risk-radar/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "risk/route", method: "GET", perm: "RISK_OR_EMERGENCY" },
  { mod: "risk/route", method: "PATCH", perm: "EMERGENCY_CONTROLS", body: { tradingHalted: true } },
  { mod: "risk/route", method: "PATCH", perm: "RISK_SETTINGS", body: { maxOpenPositionsPerAccount: 10 } },
  { mod: "search/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "settings/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "shell-info/route", method: "GET", perm: "ANY_MANAGER", supportRead: true },
  { mod: "symbols/[id]/sessions/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "symbols/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "theme/route", method: "PATCH", perm: "ANY_ADMIN", body: { theme: "dark" } },
  { mod: "transfers/route", method: "GET", perm: "INTERNAL_TRANSFERS" },
];

