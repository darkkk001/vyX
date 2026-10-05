import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { allowedBackofficeScreens } from "@/lib/backoffice-screens";
import { getRiskRadarPayload, riskRadarBadgeCount } from "@/lib/risk-radar-cache";

// GET /api/manage/badges (2026-10-05, live Neon overload): every sidebar badge count the native backoffice shows, in
// ONE request. Before, RefreshBadgesAsync loaded nine full lists (shell-info, kyc-requests, client-kyc-requests,
// live-account-requests, funds-requests, risk-radar, balance-adjustment-requests, position-action-requests,
// dealing-queue) after every admin event and every 60 s, only to count rows client-side.
//
// Contract: docs/contracts/backoffice-badges.md.
//
// Cost: one SQL statement of COUNT sub-selects (plus the signed-in MANAGER's delegated permissions, in the same
// statement), and the risk radar from its 5-minute cache (lib/risk-radar-cache.ts; computed only on a cache miss,
// exactly as GET /api/manage/risk-radar would). A screen this person may not open answers null; its count is not run at
// all when the role alone rules it out (SUPPORT), and for a MANAGER is masked once the delegated permissions are read.
//
// Semantics, each identical to the screen's own list:
//   deal   PENDING MARKET orders                       (dealing-queue `rows`, the backoffice's DEAL "Pending")
//   apr    PENDING balance-adjustment + PENDING position-action requests
//   rdr    radar rows with any flag + same-IP clusters (risk-radar)
//   kyc    PENDING account KYC + PENDING client KYC records
//   lar    PENDING live-account requests
//   dep    PENDING DEPOSIT / WITHDRAWAL transactions   (funds-requests)
//   unread unread staff notifications for this person (shell-info's unreadNotifications)
// The old list endpoints cap some lists at 200 rows; these counts are uncapped (the true queue length).

export type BadgeCounts = {
  deal: number | null;
  apr: number | null;
  rdr: number | null;
  kyc: number | null;
  lar: number | null;
  dep: number | null;
  unread: number;
  computedAt: string;
};

export type BadgeViewer = { brokerId: string; adminId: string; role: "MANAGER" | "BROKER_ADMIN" | "SUPPORT" };

// The screen codes that carry a badge, and the roles that could ever open each (lib/backoffice-screens.ts): what the
// one statement may need to count before the MANAGER's own delegated permissions are known.
const BADGE_SCREENS = ["DEAL", "APR", "RDR", "KYC", "LAR", "DEP"] as const;
type BadgeScreen = (typeof BADGE_SCREENS)[number];

function possibleScreens(role: BadgeViewer["role"]): Set<BadgeScreen> {
  // BROKER_ADMIN: every screen. MANAGER: any of them, depending on delegated permissions (resolved in the same
  // statement). SUPPORT: exactly its read-only screens, by role alone.
  if (role === "SUPPORT") return new Set(BADGE_SCREENS.filter((s) => allowedBackofficeScreens("SUPPORT", []).includes(s)));
  return new Set(BADGE_SCREENS);
}

type Row = {
  perms: string[] | null;
  deal: number | null;
  bal: number | null;
  pact: number | null;
  kyc: number | null;
  ckyc: number | null;
  lar: number | null;
  dep: number | null;
  unread: number;
};

export async function computeBadges(viewer: BadgeViewer): Promise<BadgeCounts> {
  const { brokerId, adminId, role } = viewer;
  const maybe = possibleScreens(role);
  const count = (screen: BadgeScreen, sql: Prisma.Sql) => (maybe.has(screen) ? Prisma.sql`(${sql})::int` : Prisma.sql`NULL::int`);

  const counts = prisma.$queryRaw<Row[]>`
    SELECT
      ${role === "MANAGER" ? Prisma.sql`(SELECT "extraPermissions" FROM "AdminUser" WHERE id = ${adminId})` : Prisma.sql`NULL::text[]`} AS perms,
      ${count("DEAL", Prisma.sql`SELECT count(*) FROM "Order" WHERE "brokerId" = ${brokerId} AND type = 'MARKET' AND status = 'PENDING'`)} AS deal,
      ${count("APR", Prisma.sql`SELECT count(*) FROM "BalanceAdjustmentRequest" WHERE "brokerId" = ${brokerId} AND status = 'PENDING'`)} AS bal,
      ${count("APR", Prisma.sql`SELECT count(*) FROM "PositionActionRequest" WHERE "brokerId" = ${brokerId} AND status = 'PENDING'`)} AS pact,
      ${count("KYC", Prisma.sql`SELECT count(*) FROM "KycRecord" k JOIN "Account" a ON a.id = k."accountId" WHERE a."brokerId" = ${brokerId} AND k.status = 'PENDING'`)} AS kyc,
      ${count("KYC", Prisma.sql`SELECT count(*) FROM "ClientKycRecord" k JOIN "Client" c ON c.id = k."clientId" WHERE c."brokerId" = ${brokerId} AND k.status = 'PENDING'`)} AS ckyc,
      ${count("LAR", Prisma.sql`SELECT count(*) FROM "LiveAccountRequest" WHERE "brokerId" = ${brokerId} AND status = 'PENDING'`)} AS lar,
      ${count("DEP", Prisma.sql`SELECT count(*) FROM "Transaction" WHERE "brokerId" = ${brokerId} AND type IN ('DEPOSIT', 'WITHDRAWAL') AND status = 'PENDING'`)} AS dep,
      (SELECT count(*) FROM "Notification" n
        WHERE n."brokerId" = ${brokerId} AND n."accountId" IS NULL AND n."readAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "NotificationRead" r WHERE r."notificationId" = n.id AND r."adminId" = ${adminId}))::int AS unread`;
  // RDR is role-only (every MANAGER and BROKER_ADMIN, never SUPPORT), so the cached radar loads alongside the counts
  const [[row], radar] = await Promise.all([counts, maybe.has("RDR") ? getRiskRadarPayload(brokerId) : null]);

  // the exact menu rule shell-info hands the backoffice (role + delegated permissions)
  const allowed = new Set(allowedBackofficeScreens(role, role === "MANAGER" ? (row.perms ?? []) : []));
  const gate = (screen: BadgeScreen, n: number | null) => (allowed.has(screen) && n != null ? n : null);

  return {
    deal: gate("DEAL", row.deal),
    apr: gate("APR", row.bal != null && row.pact != null ? row.bal + row.pact : null),
    rdr: allowed.has("RDR") && radar ? riskRadarBadgeCount(radar) : null,
    kyc: gate("KYC", row.kyc != null && row.ckyc != null ? row.kyc + row.ckyc : null),
    lar: gate("LAR", row.lar),
    dep: gate("DEP", row.dep),
    unread: row.unread,
    computedAt: new Date().toISOString(),
  };
}
