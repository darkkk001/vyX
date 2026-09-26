import type { Permission } from "@/lib/permission-labels";

// Phase 2 batch 4 (owner decision 2026-09-26, audit lines 86 / 118 / 131 / 141 /
// 159 / 168 / 179): the native backoffice's menu is decided HERE, on the server,
// from the signed-in person's role + delegated permissions -- the same rules the
// /api/manage/* routes enforce. GET /api/manage/shell-info returns the list; the
// backoffice builds its sidebar from it, so a screen whose data the person may
// not read is simply not in the menu (instead of opening onto a 403).
//
// `routes` names the /api/manage route modules (+ method) each screen loads to
// be useful. lib/backoffice-screens.test.ts cross-checks every screen's rule
// against lib/manage-permission-manifest.ts (the expectations the permission
// matrix test proves against the real handlers): a screen is visible to a
// persona exactly when every one of its routes lets that persona through. So
// the menu and the routes cannot drift apart silently.

export type BackofficeRole = "BROKER_ADMIN" | "MANAGER" | "SUPPORT";

export type ScreenRule =
  | { kind: "anyStaff" } // every signed-in staff member (self-service only)
  | { kind: "manager" } // MANAGER or BROKER_ADMIN
  | { kind: "brokerAdmin" } // BROKER_ADMIN only
  | { kind: "permission"; permission: Permission } // BROKER_ADMIN, or a MANAGER holding it
  | { kind: "riskOrEmergency" }; // BROKER_ADMIN, or a MANAGER holding RISK_SETTINGS or EMERGENCY_CONTROLS

export type BackofficeScreen = {
  code: string;
  rule: ScreenRule;
  // SUPPORT (read-only support role) may open it too -- only screens whose every
  // route is a SUPPORT read (lib/permissions.ts isSupportReader).
  support: boolean;
  routes: string[]; // "<module under app/api/manage/> <METHOD>"
};

export const BACKOFFICE_SCREENS: readonly BackofficeScreen[] = [
  // OVERVIEW
  { code: "DASH", rule: { kind: "manager" }, support: false, routes: ["dashboard/route GET"] },
  { code: "RPT", rule: { kind: "manager" }, support: false, routes: ["reports/summary/route GET", "reports/trading/route GET"] },
  // the LP chip inside RPT (not a nav entry of its own)
  { code: "RPT-LP", rule: { kind: "brokerAdmin" }, support: false, routes: ["reports/lp/route GET"] },
  { code: "NTF", rule: { kind: "manager" }, support: true, routes: ["notifications/route GET"] },
  // TRADING
  { code: "EXP", rule: { kind: "manager" }, support: false, routes: ["positions/route GET", "groups/route GET", "symbols/route GET"] },
  { code: "DEAL", rule: { kind: "manager" }, support: false, routes: ["dealing-queue/route GET", "dealing-desk/route GET"] },
  { code: "DLS", rule: { kind: "manager" }, support: true, routes: ["deals/route GET"] },
  { code: "SYM", rule: { kind: "manager" }, support: false, routes: ["symbols/route GET"] },
  { code: "GRP", rule: { kind: "manager" }, support: false, routes: ["groups/route GET"] },
  { code: "ATY", rule: { kind: "manager" }, support: false, routes: ["account-types/route GET"] },
  { code: "MIR", rule: { kind: "permission", permission: "MIRROR_MANAGE" }, support: false, routes: ["mirror-rules/route GET"] },
  // RISK
  { code: "RISK", rule: { kind: "riskOrEmergency" }, support: false, routes: ["risk/route GET", "margin/route GET"] },
  { code: "RDR", rule: { kind: "manager" }, support: false, routes: ["risk-radar/route GET"] },
  { code: "EMG", rule: { kind: "riskOrEmergency" }, support: false, routes: ["risk/route GET", "groups/route GET", "symbols/route GET"] },
  { code: "MRG", rule: { kind: "manager" }, support: false, routes: ["margin/route GET", "positions/route GET"] },
  // LIQUIDITY
  { code: "LP", rule: { kind: "brokerAdmin" }, support: false, routes: ["liquidity/route GET", "liquidity-providers/route GET", "lp-routing/route GET"] },
  { code: "ROUTE", rule: { kind: "brokerAdmin" }, support: false, routes: ["lp-routing/route GET"] },
  { code: "FEED", rule: { kind: "manager" }, support: false, routes: ["feed-health/route GET"] },
  // CLIENTS
  {
    code: "CLI",
    rule: { kind: "manager" },
    support: true,
    routes: [
      "accounts/route GET",
      "accounts/[id]/activity/route GET",
      "accounts/[id]/security/route GET",
      "accounts/[id]/equity-curve/route GET",
      "accounts/[id]/risk/route GET",
      "accounts/[id]/positions/route GET",
      "positions/route GET",
      "deals/route GET",
    ],
  },
  { code: "CRM", rule: { kind: "manager" }, support: false, routes: ["leads/route GET"] },
  { code: "IB", rule: { kind: "permission", permission: "IB_PAYOUTS" }, support: false, routes: ["ib-relationships/route GET"] },
  {
    code: "KYC",
    rule: { kind: "permission", permission: "KYC_REVIEW" },
    support: true,
    routes: ["kyc-requests/route GET", "client-kyc-requests/route GET", "kyc-requests/[id]/document/route GET", "client-kyc-requests/[id]/document/route GET"],
  },
  { code: "LAR", rule: { kind: "permission", permission: "KYC_REVIEW" }, support: false, routes: ["live-account-requests/route GET"] },
  // FINANCE
  { code: "DEP", rule: { kind: "permission", permission: "FUNDS_APPROVAL" }, support: true, routes: ["funds-requests/route GET"] },
  { code: "APR", rule: { kind: "manager" }, support: false, routes: ["balance-adjustment-requests/route GET", "position-action-requests/route GET"] },
  { code: "PSP", rule: { kind: "brokerAdmin" }, support: false, routes: ["payment-methods/route GET"] },
  { code: "TRX", rule: { kind: "permission", permission: "INTERNAL_TRANSFERS" }, support: false, routes: ["transfers/route GET"] },
  { code: "WAL", rule: { kind: "manager" }, support: false, routes: ["accounts/route GET", "margin/route GET", "positions/route GET"] },
  // SYSTEM
  { code: "USR", rule: { kind: "brokerAdmin" }, support: false, routes: ["admins/route GET"] },
  { code: "AUD", rule: { kind: "manager" }, support: false, routes: ["audit/route GET"] },
  // own sign-in, 2FA and sessions: /api/admin/* self-service, open to every staff role
  { code: "SEC", rule: { kind: "anyStaff" }, support: true, routes: [] },
  { code: "CFG", rule: { kind: "brokerAdmin" }, support: false, routes: ["settings/route GET"] },
];

export function screenAllowed(screen: BackofficeScreen, role: BackofficeRole, extraPermissions: readonly string[]): boolean {
  if (role === "SUPPORT") return screen.support;
  if (role === "BROKER_ADMIN") return true;
  if (role !== "MANAGER") return false;
  const rule = screen.rule;
  switch (rule.kind) {
    case "anyStaff":
    case "manager":
      return true;
    case "brokerAdmin":
      return false;
    case "permission":
      return extraPermissions.includes(rule.permission);
    case "riskOrEmergency":
      return extraPermissions.includes("RISK_SETTINGS") || extraPermissions.includes("EMERGENCY_CONTROLS");
  }
}

// The screen codes this person may open, in menu order. Anything but the three
// broker staff roles (or an unknown role string) gets nothing.
export function allowedBackofficeScreens(role: string, extraPermissions: readonly string[]): string[] {
  if (role !== "BROKER_ADMIN" && role !== "MANAGER" && role !== "SUPPORT") return [];
  return BACKOFFICE_SCREENS.filter((s) => screenAllowed(s, role, extraPermissions)).map((s) => s.code);
}
