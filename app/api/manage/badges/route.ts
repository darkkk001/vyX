import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { computeBadges } from "@/lib/backoffice-badges";

// Every backoffice sidebar badge count in one cheap request (2026-10-05): replaces the nine list loads the native
// backoffice's RefreshBadgesAsync made per refresh. Contract: docs/contracts/backoffice-badges.md.
//   200 { deal, apr, rdr, kyc, lar, dep: int | null, unread: int, computedAt: ISO-8601 }
// null = this staff member may not open that screen (the same rule shell-info's `screens` uses). Same gate as
// shell-info: any broker staff role, SUPPORT included (its KYC / DEP / unread counts), broker-scoped by the session.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const role = session!.role as "MANAGER" | "BROKER_ADMIN" | "SUPPORT";
  const badges = await computeBadges({ brokerId: session!.brokerId!, adminId: session!.adminId, role });
  return NextResponse.json(badges, { headers: { "cache-control": "no-store" } });
}
